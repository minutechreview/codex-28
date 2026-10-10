#!/usr/bin/env python3
"""Isolated browser checks for the VERSUS redesign.

Run `python3 scripts/versus-browser-qa.py`. An ephemeral loopback-only HTTP
server serves the checkout; every poll call is intercepted by a REST mock.
No Worker, Supabase project, or other cloud backend is contacted. Screenshots
and the detailed JSON report go in output/playwright/. data.json is read-only.
Requires the installed Python Playwright package and its Chromium browser.
"""

from __future__ import annotations

import argparse
import copy
import hashlib
import json
import os
from pathlib import Path
import re
import threading
import uuid
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit

from playwright.sync_api import sync_playwright, expect


ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "output" / "playwright"
NOW = "2026-10-11T01:00:00.000Z"  # Pacific October 10, round 6.
API = "https://test-versus.supabase.co"
CONFIG_FILE = "versus-config.json"
CONFIG = {"supabaseUrl": API, "publishableKey": "sb_publishable_mockabcdefghijklmnop"}
REPORT = {"checks": [], "screenshots": [], "pageErrors": [], "unexpectedRequests": []}
BASE_DATA = json.loads((ROOT / "data.json").read_text())
BASE_VERSUS = json.loads((ROOT / "versus.json").read_text())


def sha256(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def passed(name, detail=None):
    item = {"name": name, "passed": True}
    if detail is not None:
        item["detail"] = detail
    REPORT["checks"].append(item)
    print(f"PASS {name}", flush=True)


class QuietHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def log_message(self, *_args):
        pass


def start_site():
    configured = os.environ.get("VERSUS_SITE_URL")
    if configured:
        assert urlsplit(configured).hostname in ("127.0.0.1", "localhost", "::1"), \
            "Browser QA must use a loopback site."
        return configured, None
    server = ThreadingHTTPServer(("127.0.0.1", 0), QuietHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return f"http://127.0.0.1:{server.server_port}", server


def freeze_time(context, now=NOW):
    # Native Intl still calculates real Pacific offsets, including DST.
    context.add_init_script("""(() => {
      const NativeDate = Date;
      window.__qaNow = NativeDate.parse(%s);
      window.Date = class extends NativeDate {
        constructor(...args) { super(...(args.length ? args : [window.__qaNow])); }
        static now() { return window.__qaNow; }
      };
    })();""" % json.dumps(now))


class MockPoll:
    """Single-device-per-Pacific-day transactional mock, never a real service.

    The client contract is matched to the proposed atomic RPC. Server-side SQL
    guards are exercised separately by the backend test suite; this mock checks
    how the browser responds to acceptance, conflicts, and ambiguous responses.
    """

    def __init__(self, dots=3, bots=1):
        self.counts = {"dots": dots, "bots": bots}
        self.day = "2026-10-10"
        self.votes = {}
        self.users = {}
        self.calls = []
        self.fail_reads = False
        self.fail_votes = False
        self.fail_auth = False
        self.lose_next_response = False
        self.lose_before_commit = False
        self.foreign_choice = None
        self.next_counts = None

    def route(self, route):
        request = route.request
        body = request.post_data_json if request.post_data else {}
        self.calls.append({"method": request.method, "url": request.url, "body": body})
        if request.method == "OPTIONS":
            self.respond(route, {})
            return
        path = urlsplit(request.url).path
        if path.startswith("/auth/v1/"):
            if self.fail_auth:
                self.respond(route, {"code": "over_request_rate_limit"}, status=429)
                return
            if path == "/auth/v1/signup":
                assert body == {"data": {}}, body
                user_id = str(uuid.uuid4())
                token = f"qa-token-{len(self.users) + 1}"
                self.users[token] = user_id
            elif path == "/auth/v1/token":
                token = body.get("refresh_token", "").removeprefix("refresh-")
                assert token in self.users, body
                user_id = self.users[token]
            else:
                raise AssertionError(f"Unexpected auth endpoint: {path}")
            self.respond(route, {"access_token": token, "refresh_token": "refresh-" + token,
                                 "expires_at": 1893456000, "user": {"id": user_id}})
            return
        assert path in ("/rest/v1/rpc/versus_results", "/rest/v1/rpc/cast_versus_vote"), path
        assert request.headers.get("apikey") == CONFIG["publishableKey"], request.headers
        token = request.headers.get("authorization", "").removeprefix("Bearer ")
        assert token in self.users, "RPC must be authenticated as the anonymous visitor."
        device = self.users[token]
        is_vote = path.endswith("/cast_versus_vote")
        if (self.fail_reads and not is_vote) or (self.fail_votes and is_vote):
            self.respond(route, {"message": "QA service unavailable"}, status=503)
            return
        day = self.day
        choice = body.get("p_team")
        key = (day, device)
        accepted = False
        if is_vote:
            assert choice in ("dots", "bots"), body
            if body.get("p_expected_day") != day:
                self.respond(route, {"code": "22023", "message": "Pacific day changed"}, status=400)
                return
            if self.lose_before_commit:
                self.lose_before_commit = False
                route.abort("failed")
                return
            if self.foreign_choice and key not in self.votes:
                self.votes[key] = self.foreign_choice
                self.counts[self.foreign_choice] += 1
            if key not in self.votes:
                self.votes[key] = choice
                self.counts[choice] += 1
                accepted = True
            if self.lose_next_response:
                self.lose_next_response = False
                route.abort("failed")
                return
        if self.next_counts is not None:
            self.counts = self.next_counts
            self.next_counts = None
        self.respond(route, self.result(day, device, accepted=accepted if is_vote else None))

    def result(self, day, device, accepted=None):
        result = {"day": day, "open": True, "dotsVotes": self.counts["dots"],
                  "botsVotes": self.counts["bots"],
                  "totalVotes": sum(self.counts.values()),
                  "yourVote": self.votes.get((day, device))}
        if accepted is not None:
            result["accepted"] = accepted
        return result

    @staticmethod
    def respond(route, result, status=200):
        route.fulfill(status=status, content_type="application/json",
                      headers={"Access-Control-Allow-Origin": "*",
                               "Access-Control-Allow-Headers": "*"},
                      body=json.dumps(result))


def setup_context(browser, site, *, width=1440, height=1000, now=NOW,
                  configured=False, mock=None, data=None, versus=None,
                  reduced=False, storage_blocked=False, data_failure=None):
    context = browser.new_context(viewport={"width": width, "height": height},
                                  reduced_motion="reduce" if reduced else "no-preference",
                                  is_mobile=width <= 390, has_touch=width <= 390)
    freeze_time(context, now)
    site_origin = f"{urlsplit(site).scheme}://{urlsplit(site).netloc}"

    def network(route):
        url = route.request.url
        parsed = urlsplit(url)
        if url.startswith(API):
            assert configured and mock, "Unconfigured site called Supabase."
            mock.route(route)
        elif parsed.netloc == urlsplit(site_origin).netloc:
            if parsed.path.endswith("/" + CONFIG_FILE):
                route.fulfill(status=200, content_type="application/json",
                              body=json.dumps(CONFIG if configured else {"supabaseUrl": None, "publishableKey": None}))
            elif parsed.path.endswith("/data.json") and data_failure and data_failure[0]:
                route.fulfill(status=503, content_type="application/json", body='{"error":"QA unavailable"}')
            elif parsed.path.endswith("/data.json") and data is not None:
                route.fulfill(status=200, content_type="application/json", body=json.dumps(data))
            elif parsed.path.endswith("/versus.json") and versus is not None:
                route.fulfill(status=200, content_type="application/json", body=json.dumps(versus))
            else:
                route.continue_()
        elif parsed.hostname in ("fonts.googleapis.com", "fonts.gstatic.com"):
            # Public font downloads contain no project data or credentials.
            route.continue_()
        else:
            REPORT["unexpectedRequests"].append(url)
            route.abort("blockedbyclient")

    context.route("**/*", network)
    if storage_blocked:
        context.add_init_script("""(() => {
          Storage.prototype.getItem = () => { throw new DOMException('QA storage blocked', 'SecurityError'); };
          Storage.prototype.setItem = () => { throw new DOMException('QA storage blocked', 'SecurityError'); };
        })();""")
    page = context.new_page()
    page.on("pageerror", lambda error: REPORT["pageErrors"].append(str(error)))
    return context, page


def load(page, site):
    page.goto(site, wait_until="networkidle")
    expect(page.locator("#fighter-dots img")).to_be_visible()
    expect(page.locator("#fighter-bots img")).to_be_visible()


def screenshot(page, name):
    page.evaluate("() => { document.activeElement?.blur(); window.scrollTo({top:0,left:0,behavior:'instant'}); }")
    page.wait_for_function("window.scrollY === 0")
    path = OUT / name
    page.screenshot(path=str(path), full_page=True, animations="disabled")
    REPORT["screenshots"].append(str(path.relative_to(ROOT)))


def check_round(page, number):
    expect(page.locator("#round-number")).to_contain_text(str(number))


def set_time(page, now):
    page.evaluate("now => { window.__qaNow = Date.parse(now); document.dispatchEvent(new Event('visibilitychange')); }", now)


def test_visuals(browser, site, screenshots):
    metrics = []
    for width in (320, 390, 768, 1440):
        context, page = setup_context(browser, site, width=width, height=844 if width <= 390 else 1000)
        try:
            load(page, site)
            check_round(page, 6)
            expect(page.locator("#poll-status")).to_contain_text("COMING SOON")
            expect(page.locator("#vote-dots")).to_be_disabled()
            expect(page.locator("#vote-bots")).to_be_disabled()
            assert page.locator("#fighter-dots img, #fighter-bots img").evaluate_all(
                "imgs => imgs.length === 2 && imgs.every(i => i.complete && i.naturalWidth > 0)")
            overflow = page.evaluate("({viewport:innerWidth,document:document.documentElement.scrollWidth,body:document.body.scrollWidth})")
            assert overflow["document"] <= width and overflow["body"] <= width, overflow
            touch = page.locator("#sound-toggle, #vote-dots, #vote-bots").evaluate_all(
                "bs => bs.map(b=>({id:b.id,width:b.getBoundingClientRect().width,height:b.getBoundingClientRect().height,tag:b.tagName}))")
            assert all(b["tag"] == "BUTTON" and b["height"] >= 44 and b["width"] >= 44 for b in touch), touch
            metrics.append({"width": width, "overflow": overflow, "buttons": touch})
            if screenshots and width in (390, 1440):
                screenshot(page, "versus-mobile-390.png" if width == 390 else "versus-desktop.png")
        finally:
            context.close()
    passed("320/390/768/1440 layouts, portrait loading, real 44px buttons, and unconfigured COMING SOON", metrics)


def test_controls(browser, site):
    context, page = setup_context(browser, site)
    try:
        load(page, site)
        sound = page.locator("#sound-toggle")
        expect(sound).to_have_attribute("aria-pressed", "false")
        sound.focus()
        expect(sound).to_be_focused()
        focus = sound.evaluate("b => {const s=getComputedStyle(b); return {style:s.outlineStyle,width:parseFloat(s.outlineWidth),offset:parseFloat(s.outlineOffset)}}")
        assert focus["style"] != "none" and focus["width"] >= 2, focus
        page.keyboard.press("Enter")
        expect(sound).to_have_attribute("aria-pressed", "true")
        page.keyboard.press("Space")
        expect(sound).to_have_attribute("aria-pressed", "false")
        disclaimer = "Not affiliated with OpenAI or SpaceXAI. Fan-made tracker."
        expect(page.locator("footer")).to_contain_text(disclaimer)
        assert page.locator('meta[property="og:image"]').get_attribute("content"), "Static share image missing."
        passed("Sound starts muted, native Enter/Space controls and visible keyboard focus, footer and OG image")
    finally:
        context.close()

    classified = copy.deepcopy(BASE_VERSUS)
    grok_entries = [entry for day in classified["days"] for entry in day["grokbot"]]
    for entry in grok_entries:
        entry["status"] = "improvement"
    grok_entries[0]["status"] = "reset"
    context, page = setup_context(browser, site, versus=classified)
    try:
        load(page, site)
        dots_hits = sum(day["status"] == "improvement" for day in BASE_DATA["days"])
        dots_resets = sum(day["status"] == "reset" for day in BASE_DATA["days"])
        expect(page.locator("#hits-dots")).to_contain_text(str(dots_hits))
        expect(page.locator("#resets-dots")).to_contain_text(str(dots_resets))
        expect(page.locator("#hits-bots")).to_contain_text(str(len(grok_entries) - 1))
        expect(page.locator("#resets-bots")).to_contain_text("1")
        passed("Explicit source classifications render separate improvements and resets for both teams")
    finally:
        context.close()

    context, page = setup_context(browser, site, reduced=True)
    try:
        load(page, site)
        animated = page.locator("*").evaluate_all("""els => els.filter(e => {
          const s=getComputedStyle(e), t=e.getBoundingClientRect();
          return t.width && t.height && s.animationName !== 'none' &&
            s.animationDuration.split(',').some(v=>parseFloat(v) > 0.01);
        }).map(e=>({tag:e.tagName,id:e.id,class:e.className}));""")
        assert not animated, animated
        passed("Reduced-motion disables visible breathing, shaking, and flashing animations")
    finally:
        context.close()


def test_data(browser, site):
    failed = [True]
    context, page = setup_context(browser, site, data_failure=failed)
    try:
        page.goto(site, wait_until="networkidle")
        expect(page.locator("#data-status")).to_contain_text(re.compile(r"could not|unavailable|failed|error", re.I))
        failed[0] = False
        page.locator("#data-refresh").click()
        expect(page.locator("#timeline")).to_contain_text(BASE_DATA["days"][0]["summary"])
        passed("Data fetch failure is visible and refresh recovers source records")
    finally:
        context.close()

    data = copy.deepcopy(BASE_DATA)
    versus = copy.deepcopy(BASE_VERSUS)
    data["days"][0]["summary"] = "QA Tibo source sentinel: public data changed only in memory."
    versus["days"][0]["grokbot"][0]["summary"] = "QA Grok source sentinel: companion data changed only in memory."
    context, page = setup_context(browser, site, data=data, versus=versus)
    try:
        load(page, site)
        expect(page.locator("#timeline")).to_contain_text(data["days"][0]["summary"])
        expect(page.locator("#timeline")).to_contain_text(versus["days"][0]["grokbot"][0]["summary"])
        for filename in ("versus-app.js", "versus-model.js"):
            path = ROOT / filename
            if path.exists():
                source = path.read_text()
                for entry in BASE_DATA["days"]:
                    if entry["summary"]:
                        assert entry["summary"] not in source, f"Hardcoded data summary in {filename}"
                for day in BASE_VERSUS["days"]:
                    for entry in day["grokbot"]:
                        assert entry["summary"] not in source, f"Hardcoded Grok record in {filename}"
        passed("Tibo/Grok summaries are rendered from fetched data; authored UI/model contain no known hardcoded records")
    finally:
        context.close()


def test_time(browser, site):
    context, page = setup_context(browser, site, now="2026-10-11T06:59:59.000Z")
    try:
        load(page, site)
        check_round(page, 6)
        expect(page.locator("#countdown")).to_contain_text("00:00:01")
        set_time(page, "2026-10-11T07:00:00.000Z")
        check_round(page, 7)
        expect(page.locator("#countdown")).to_contain_text("24:00:00")
        passed("Pacific midnight advances round 6 to 7 with a new countdown")
    finally:
        context.close()

    context, page = setup_context(browser, site, now="2026-11-02T08:00:00.000Z")
    try:
        load(page, site)
        expect(page.locator("#finale")).to_be_visible()
        expect(page.locator("#finale")).to_contain_text(re.compile(r"unresolved|pending|unknown|insufficient", re.I))
        assert "winner: team" not in page.locator("#finale").inner_text().lower(), \
            "Unclassified/unfinished source data cannot establish a final winner."
        passed("Closing round 28 with real pending/unclassified records does not invent a KO winner")
    finally:
        context.close()

    data = copy.deepcopy(BASE_DATA)
    versus = copy.deepcopy(BASE_VERSUS)
    for day in data["days"]:
        day.update(status="missed", summary="QA fixture: explicitly reported no improvement.", tweetUrl=None)
    data["days"][0].update(status="improvement", summary="QA fixture: one explicitly classified improvement.")
    for day in versus["days"]:
        day["grokbot"] = []
    context, page = setup_context(browser, site, now="2026-11-02T08:00:00.000Z", data=data, versus=versus)
    try:
        load(page, site)
        expect(page.locator("#finale")).to_contain_text(re.compile(r"KO", re.I))
        expect(page.locator("#finale")).to_contain_text(re.compile(r"dots", re.I))
        passed("Fully classified in-memory results select the final KO winner from source improvements")
    finally:
        context.close()

    # The fall-back transition is on round 28, a 25-hour Pacific day.
    context, page = setup_context(browser, site, now="2026-11-01T07:00:00.000Z")
    try:
        load(page, site)
        check_round(page, 28)
        expect(page.locator("#countdown")).to_contain_text("25:00:00")
        set_time(page, "2026-11-01T09:00:00.000Z")
        expect(page.locator("#countdown")).to_contain_text("23:00:00")
        passed("DST fall-back countdown measures the 25-hour Pacific final round")
    finally:
        context.close()


def assert_counts_and_health(page, dots, bots):
    total = dots + bots
    expect(page.locator("#votes-dots")).to_contain_text(re.compile(rf"\b{dots}\b"))
    expect(page.locator("#votes-bots")).to_contain_text(re.compile(rf"\b{bots}\b"))
    expect(page.locator("#votes-total")).to_contain_text(re.compile(rf"\b{total}\b"))
    expected = {"dots": 100 - 100 * bots / max(total, 1) * 0.9,
                "bots": 100 - 100 * dots / max(total, 1) * 0.9}
    for team, health in expected.items():
        expect(page.locator(f"#health-{team}")).to_have_attribute("aria-valuenow", re.compile(r"\d"))
        actual = float(page.locator(f"#health-{team}").get_attribute("aria-valuenow"))
        assert abs(actual - health) < 0.01, {"team": team, "expected": health, "actual": actual}


def test_poll(browser, site):
    mock = MockPoll()
    context, page = setup_context(browser, site, configured=True, mock=mock)
    try:
        load(page, site)
        try:
            expect(page.locator("#vote-dots")).to_be_enabled()
        except AssertionError as error:
            flags = page.evaluate("async () => { let nativeFetch='ok'; try { await fetch.call({},'./data.json'); } catch(e) {nativeFetch=e.toString();} return {locks:!!navigator.locks,secure:isSecureContext,nativeFetch}; }")
            raise AssertionError(f"Configured poll failed: {page.locator('#poll-status').inner_text()}; mock calls={mock.calls}; browser flags={flags}") from error
        expect(page.locator("#vote-bots")).to_be_enabled()
        assert_counts_and_health(page, 3, 1)
        page.locator("#vote-dots").focus()
        page.keyboard.press("Enter")
        expect(page.locator("#poll-status")).to_contain_text("LOCKED IN")
        expect(page.locator("#vote-dots")).to_be_disabled()
        expect(page.locator("#vote-bots")).to_be_disabled()
        assert mock.counts == {"dots": 4, "bots": 1}, mock.counts
        assert_counts_and_health(page, 4, 1)
        page.reload(wait_until="networkidle")
        expect(page.locator("#vote-bots")).to_be_disabled()
        assert mock.counts == {"dots": 4, "bots": 1}, mock.counts
        vote_calls = [call for call in mock.calls if call["url"].endswith("/cast_versus_vote")]
        assert len(vote_calls) == 1, vote_calls
        stored = page.evaluate("Object.fromEntries(Object.entries(localStorage).map(([k,v])=>[k,JSON.parse(v)]))")
        assert all(not any(key in value for key in ("dotsVotes", "botsVotes", "totalVotes"))
                   for value in stored.values() if isinstance(value, dict)), stored
        passed("Configured REST mock counts, exact health formula, keyboard vote, repeat lock, and no local authoritative counts")
    finally:
        context.close()

    # A conflicting response models another tab winning the atomic transaction.
    mock = MockPoll(dots=0, bots=0)
    mock.foreign_choice = "bots"
    context, page = setup_context(browser, site, configured=True, mock=mock)
    try:
        load(page, site)
        expect(page.locator("#vote-dots")).to_be_enabled()
        page.locator("#vote-dots").click()
        expect(page.locator("#vote-bots")).to_be_disabled()
        expect(page.locator("#vote-dots")).to_be_disabled()
        expect(page.locator("#poll-status")).to_contain_text(re.compile(r"bots", re.I))
        assert mock.counts == {"dots": 0, "bots": 1}, mock.counts
        assert_counts_and_health(page, 0, 1)
        passed("Atomic duplicate/race response honors the server's original team and adds no second vote")
    finally:
        context.close()

    mock = MockPoll(dots=0, bots=0)
    mock.lose_next_response = True
    context, page = setup_context(browser, site, configured=True, mock=mock)
    try:
        load(page, site)
        expect(page.locator("#vote-bots")).to_be_enabled()
        page.locator("#vote-bots").click()
        expect(page.locator("#poll-status")).to_contain_text("VOTE UNCONFIRMED")
        expect(page.locator("#vote-dots")).to_be_disabled()
        assert mock.counts == {"dots": 0, "bots": 1}, mock.counts
        page.locator("#poll-refresh").click()
        expect(page.locator("#vote-bots")).to_be_disabled()
        expect(page.locator("#poll-status")).to_contain_text(re.compile(r"bots", re.I))
        assert mock.counts == {"dots": 0, "bots": 1}, mock.counts
        vote_calls = [call for call in mock.calls if call["url"].endswith("/cast_versus_vote")]
        assert len(vote_calls) == 1, vote_calls
        passed("Lost vote response keeps the choice pending; refresh confirms the committed vote without re-posting")
    finally:
        context.close()

    mock = MockPoll(dots=0, bots=0)
    mock.lose_before_commit = True
    context, page = setup_context(browser, site, configured=True, mock=mock)
    try:
        load(page, site)
        expect(page.locator("#vote-dots")).to_be_enabled()
        page.locator("#vote-dots").click()
        expect(page.locator("#poll-status")).to_contain_text("VOTE UNCONFIRMED")
        expect(page.locator("#vote-bots")).to_be_disabled()
        assert mock.counts == {"dots": 0, "bots": 0}, mock.counts
        page.locator("#poll-refresh").click()
        expect(page.locator("#poll-status")).to_contain_text("LOCKED IN")
        assert mock.counts == {"dots": 1, "bots": 0}, mock.counts
        vote_calls = [call for call in mock.calls if call["url"].endswith("/cast_versus_vote")]
        assert len(vote_calls) == 2 and vote_calls[0]["body"] == vote_calls[1]["body"], vote_calls
        passed("Uncommitted lost response refresh retries the original side and produces exactly one server vote")
    finally:
        context.close()

    mock = MockPoll(dots=0, bots=0)
    context, page = setup_context(browser, site, configured=True, mock=mock)
    try:
        load(page, site)
        expect(page.locator("#vote-dots")).to_be_enabled()
        page.locator("#vote-dots").click()
        expect(page.locator("#poll-status")).to_contain_text("LOCKED IN")
        old_votes = dict(mock.votes)
        mock.day = "2026-10-11"
        mock.counts = {"dots": 0, "bots": 0}
        set_time(page, "2026-10-11T07:00:00.000Z")
        check_round(page, 7)
        expect(page.locator("#vote-bots")).to_be_enabled()
        assert_counts_and_health(page, 0, 0)
        page.locator("#vote-bots").click()
        expect(page.locator("#poll-status")).to_contain_text("LOCKED IN")
        assert mock.counts == {"dots": 0, "bots": 1}, mock.counts
        assert all(mock.votes[key] == value for key, value in old_votes.items())
        assert len(mock.users) == 1, "Pacific rollover must retain the same anonymous device identity."
        passed("PT midnight refresh opens a new daily vote while preserving yesterday's choice and anonymous identity")
    finally:
        context.close()

    mock = MockPoll()
    mock.fail_reads = True
    context, page = setup_context(browser, site, configured=True, mock=mock)
    try:
        load(page, site)
        expect(page.locator("#poll-status")).to_contain_text(re.compile(r"unavailable|could not|failed|error", re.I))
        expect(page.locator("#vote-dots")).to_be_disabled()
        expect(page.locator("#vote-bots")).to_be_disabled()
        mock.fail_reads = False
        page.locator("#poll-refresh").click()
        expect(page.locator("#vote-dots")).to_be_enabled()
        assert_counts_and_health(page, 3, 1)
        mock.fail_reads = True
        page.locator("#poll-refresh").click()
        expect(page.locator("#poll-status")).to_contain_text(re.compile(r"last|stale|unavailable|could not", re.I))
        expect(page.locator("#vote-dots")).to_be_disabled()
        assert mock.counts == {"dots": 3, "bots": 1}, mock.counts
        passed("REST read error disables voting, refresh recovers, and later failure does not fabricate counts")
    finally:
        context.close()

    mock = MockPoll()
    mock.fail_auth = True
    context, page = setup_context(browser, site, configured=True, mock=mock)
    try:
        load(page, site)
        expect(page.locator("#vote-dots")).to_be_disabled()
        expect(page.locator("#poll-status")).to_contain_text(re.compile(r"rate|wait|unavailable|could not", re.I))
        assert not any("/rest/v1/" in call["url"] for call in mock.calls), mock.calls
        passed("Anonymous-auth rate limit fails closed before any vote RPC")
    finally:
        context.close()

    mock = MockPoll()
    context, page = setup_context(browser, site, configured=True, mock=mock, storage_blocked=True)
    try:
        load(page, site)
        expect(page.locator("#vote-dots")).to_be_disabled()
        expect(page.locator("#poll-status")).to_contain_text(re.compile(r"storage|browser", re.I))
        assert not mock.calls, mock.calls
        passed("Blocked localStorage fails closed before anonymous signup or a vote request")
    finally:
        context.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--no-screenshots", action="store_true", help="Run checks without overwriting final visual artifacts")
    parser.add_argument("--only", choices=("visuals", "controls", "data", "time", "poll"), help="Run one group while fixing a failure")
    args = parser.parse_args()
    OUT.mkdir(parents=True, exist_ok=True)
    original_hash = sha256(ROOT / "data.json")
    REPORT["dataHashBefore"] = original_hash
    site, server = start_site()
    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            try:
                if args.only in (None, "visuals"):
                    test_visuals(browser, site, not args.no_screenshots)
                if args.only in (None, "controls"):
                    test_controls(browser, site)
                if args.only in (None, "data"):
                    test_data(browser, site)
                if args.only in (None, "time"):
                    test_time(browser, site)
                if args.only in (None, "poll"):
                    test_poll(browser, site)
                assert not REPORT["pageErrors"], REPORT["pageErrors"]
                assert not REPORT["unexpectedRequests"], REPORT["unexpectedRequests"]
                passed("No JavaScript exceptions, legacy Worker requests, or unexpected external requests")
            finally:
                browser.close()
    except Exception as error:
        REPORT["failure"] = str(error)
        raise
    finally:
        if server:
            server.shutdown()
            server.server_close()
        REPORT["dataHashAfter"] = sha256(ROOT / "data.json")
        assert REPORT["dataHashAfter"] == original_hash, "data.json changed during read-only browser QA"
        (OUT / "versus-browser-qa.json").write_text(json.dumps(REPORT, indent=2) + "\n")
        print(f"Report: {OUT / 'versus-browser-qa.json'}", flush=True)


if __name__ == "__main__":
    main()
