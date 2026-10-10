#!/usr/bin/env python3
"""Isolated browser checks for the VERSUS redesign.

Run `python3 scripts/versus-browser-qa.py`. An ephemeral loopback-only HTTP
server serves the checkout; every poll call is intercepted by a REST mock.
No live Worker or other cloud backend is contacted. Screenshots
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
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, unquote, urlsplit

from playwright.sync_api import sync_playwright, expect


ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "output" / "playwright"
NOW = "2026-10-11T01:00:00.000Z"  # Pacific October 10, round 6.
API = "http://127.0.0.1:8787"
CONFIG_FILE = "versus-config.json"
CONFIG = {"apiBaseUrl": API}
REPORT = {"checks": [], "screenshots": [], "pageErrors": [], "unexpectedRequests": []}
BASE_DATA = json.loads((ROOT / "data.json").read_text())
BASE_VERSUS = json.loads((ROOT / "versus.json").read_text())
BASE_VOTING_CONFIG = json.loads((ROOT / "voting-config.json").read_text())


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

    The client contract matches the separate Worker /teams/:day route. SQL
    guards are exercised separately by the backend test suite; this mock checks
    how the browser responds to acceptance, conflicts, and ambiguous responses.
    """

    def __init__(self, dots=3, bots=1):
        self.counts = {"dots": dots, "bots": bots}
        self.day = "2026-10-10"
        self.votes = {}
        self.identities = set()
        self.calls = []
        self.fail_reads = False
        self.fail_votes = False
        self.rate_limit = False
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
        assert re.fullmatch(r"/teams/\d{4}-\d{2}-\d{2}", path), path
        query = parse_qs(urlsplit(request.url).query)
        device = body.get("voterId") if request.method == "POST" else query.get("voterId", [None])[0]
        if device:
            assert re.fullmatch(r"[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}", device), device
            self.identities.add(device)
        is_vote = request.method == "POST"
        if self.rate_limit and is_vote:
            self.respond(route, {"error": {"code": "rate_limited", "message": "QA rate limited"}}, status=429)
            return
        if (self.fail_reads and not is_vote) or (self.fail_votes and is_vote):
            self.respond(route, {"message": "QA service unavailable"}, status=503)
            return
        day = self.day
        choice = body.get("choice")
        key = (day, device)
        accepted = False
        if is_vote:
            assert choice in ("dots", "bots"), body
            assert set(body) == {"voterId", "choice"}, body
            if path != f"/teams/{day}":
                self.respond(route, {"error": {"code": "day_changed", "message": "Pacific day changed"}}, status=409)
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


class MockApprovalPoll:
    """Original per-Tibo-day approval namespace, independent of team votes."""

    def __init__(self):
        self.calls = []
        self.counts = {}
        self.votes = {}
        self.identities = set()
        self.fail_reads = False
        self.lose_response = False

    def route(self, route):
        request = route.request
        parsed = urlsplit(request.url)
        poll_id = unquote(parsed.path.removeprefix("/polls/"))
        assert re.fullmatch(r"codex-28:\d{4}-\d{2}-\d{2}:day-\d+", poll_id), poll_id
        body = request.post_data_json if request.post_data else {}
        self.calls.append({"method": request.method, "pollId": poll_id, "body": body})
        if self.fail_reads and request.method == "GET":
            MockPoll.respond(route, {"error": {"code": "qa_unavailable"}}, status=503)
            return
        voter = body.get("voterId") if request.method == "POST" else parse_qs(parsed.query).get("voterId", [None])[0]
        if voter:
            self.identities.add(voter)
        counts = self.counts.setdefault(poll_id, {"approve": 0, "not_convinced": 0})
        key = (poll_id, voter)
        accepted = False
        if request.method == "POST":
            assert set(body) == {"voterId", "choice"}, body
            choice = body["choice"]
            assert choice in ("approve", "not_convinced") and voter, body
            if key not in self.votes:
                self.votes[key] = choice
                counts[choice] += 1
                accepted = True
            if self.lose_response:
                self.lose_response = False
                route.abort("failed")
                return
        result = {"pollId": poll_id, "approve": counts["approve"],
                  "notConvinced": counts["not_convinced"], "total": sum(counts.values()),
                  "yourVote": self.votes.get(key)}
        if request.method == "POST":
            result["accepted"] = accepted
        MockPoll.respond(route, result)


def setup_context(browser, site, *, width=1440, height=1000, now=NOW,
                  configured=False, mock=None, data=None, versus=None,
                  reduced=False, storage_blocked=False, data_failure=None,
                  approval_configured=False, approval_mock=None, canonical=False):
    context = browser.new_context(viewport={"width": width, "height": height},
                                  reduced_motion="reduce" if reduced else "no-preference",
                                  is_mobile=width <= 390, has_touch=width <= 390)
    freeze_time(context, now)
    site_origin = f"{urlsplit(site).scheme}://{urlsplit(site).netloc}"

    def network(route):
        url = route.request.url
        parsed = urlsplit(url)
        if url.startswith(API):
            if parsed.path.startswith("/teams/"):
                assert configured and mock, "Unconfigured site called the team Worker."
                mock.route(route)
            elif parsed.path.startswith("/polls/"):
                assert approval_configured and approval_mock, "Unconfigured site called the approval Worker."
                approval_mock.route(route)
            else:
                raise AssertionError(f"Unexpected Worker endpoint: {parsed.path}")
        elif parsed.netloc == urlsplit(site_origin).netloc:
            if parsed.path.endswith("/" + CONFIG_FILE):
                route.fulfill(status=200, content_type="application/json",
                              body=json.dumps(CONFIG if configured else {"apiBaseUrl": None}))
            elif parsed.path.endswith("/voting-config.json"):
                if canonical:
                    route.continue_()
                else:
                    route.fulfill(status=200, content_type="application/json",
                                  body=json.dumps({"apiBaseUrl": API if approval_configured else None}))
            elif parsed.path.endswith("/data.json") and data_failure and data_failure[0]:
                route.fulfill(status=503, content_type="application/json", body='{"error":"QA unavailable"}')
            elif parsed.path.endswith("/data.json") and data is not None:
                route.fulfill(status=200, content_type="application/json", body=json.dumps(data))
            elif parsed.path.endswith("/versus.json") and versus is not None:
                route.fulfill(status=200, content_type="application/json", body=json.dumps(versus))
            else:
                route.continue_()
        elif canonical and parsed.path.startswith("/polls/") and url.startswith(BASE_VOTING_CONFIG["apiBaseUrl"]):
            assert approval_configured and approval_mock
            approval_mock.route(route)
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
        unavailable_approval = MockApprovalPoll()
        unavailable_approval.fail_reads = True
        context, page = setup_context(browser, site, width=width, height=844 if width <= 390 else 1000,
                                      approval_configured=screenshots, approval_mock=unavailable_approval,
                                      canonical=screenshots)
        try:
            load(page, site)
            check_round(page, 6)
            expect(page.locator("#poll-status")).to_contain_text("COMING SOON")
            expect(page.locator("#vote-dots")).to_be_disabled()
            expect(page.locator("#vote-bots")).to_be_disabled()
            assert page.locator("#fighter-dots img, #fighter-bots img").evaluate_all(
                "imgs => imgs.length === 2 && imgs.every(i => i.complete && i.naturalWidth > 0)")
            expect(page.locator("#name-bots")).to_have_text(BASE_VERSUS["teams"]["bots"]["name"])
            expect(page.locator("#portrait-bots")).to_have_attribute("alt", BASE_VERSUS["teams"]["bots"]["name"])
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

    context, page = setup_context(browser, site)
    try:
        load(page, site)
        tibo = [entry for day in BASE_VERSUS["days"] for entry in day["tibo"]]
        dots_hits = sum(e["status"] == "improvement" for e in tibo)
        dots_resets = sum(day["status"] == "reset" for day in BASE_DATA["days"])
        expect(page.locator("#hits-dots")).to_contain_text(str(dots_hits))
        expect(page.locator("#resets-dots")).to_contain_text(str(dots_resets))
        grok = [entry for day in BASE_VERSUS["days"] for entry in day["grokbot"]]
        if all("status" in entry for entry in grok):
            expect(page.locator("#hits-bots")).to_contain_text(str(sum(e["status"] == "improvement" for e in grok)))
            expect(page.locator("#resets-bots")).to_contain_text(str(sum(e["status"] == "reset" for e in grok)))
        else:
            expect(page.locator("#hits-bots")).to_contain_text("?")
            expect(page.locator("#resets-bots")).to_contain_text("?")
        for index, day in enumerate(BASE_VERSUS["days"]):
            for entry in day["tibo"] + day["grokbot"]:
                expect(page.locator("#timeline")).to_contain_text(f"UPDATE {entry['number']}")
            if BASE_DATA["days"][index]["status"] == "reset":
                row = page.locator(f'.round-row[aria-label^="Round {index + 1},"]')
                expect(row.locator(".round-lane.dots")).to_contain_text("USAGE RESET")
                expect(row.locator(".round-lane.dots")).to_contain_text("RESET · NO HIT")
        passed("Every listed Tibo and Grok update renders as one hit; usage resets show on their day without counting or zeroing launches")
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
        expect(page.locator("#timeline")).to_contain_text(BASE_VERSUS["days"][0]["tibo"][0]["summary"])
        passed("Data fetch failure is visible and refresh recovers source records")
    finally:
        context.close()

    data = copy.deepcopy(BASE_DATA)
    versus = copy.deepcopy(BASE_VERSUS)
    data["days"][1]["summary"] = "QA Tibo source sentinel: public data changed only in memory."
    versus["days"][0]["tibo"][0]["summary"] = "QA Tibo update sentinel: companion data changed only in memory."
    versus["days"][0]["grokbot"][0]["summary"] = "QA Grok source sentinel: companion data changed only in memory."
    context, page = setup_context(browser, site, data=data, versus=versus)
    try:
        load(page, site)
        expect(page.locator("#timeline")).to_contain_text(data["days"][1]["summary"])
        expect(page.locator("#timeline")).to_contain_text(versus["days"][0]["tibo"][0]["summary"])
        expect(page.locator("#timeline")).to_contain_text(versus["days"][0]["grokbot"][0]["summary"])
        for filename in ("versus-app.js", "versus-model.js"):
            path = ROOT / filename
            if path.exists():
                source = path.read_text()
                for entry in BASE_DATA["days"]:
                    if entry["summary"]:
                        assert entry["summary"] not in source, f"Hardcoded data summary in {filename}"
                for day in BASE_VERSUS["days"]:
                    for entry in day["grokbot"] + day["tibo"]:
                        assert entry["summary"] not in source, f"Hardcoded Grok record in {filename}"
        passed("Tibo/Grok summaries are rendered from fetched data; authored UI/model contain no known hardcoded records")
    finally:
        context.close()

    malformed = copy.deepcopy(BASE_VERSUS)
    original_status = malformed["days"][0]["grokbot"][0].get("status")
    malformed["days"][0]["grokbot"][0]["type"] = "improvement"
    context, page = setup_context(browser, site, versus=malformed)
    try:
        page.goto(site, wait_until="networkidle")
        expect(page.locator("#data-status")).to_contain_text("Data unavailable")
        expect(page.locator("#round-number")).to_have_text("--")
        del malformed["days"][0]["grokbot"][0]["type"]
        page.locator("#data-refresh").click()
        check_round(page, 6)
        if original_status is None:
            expect(page.locator("#hits-bots")).to_contain_text("?")
        else:
            expect(page.locator("#hits-bots")).not_to_contain_text("?")
        passed("Unknown Grok source fields fail strict validation; retry recovers the source schema without inventing classification")
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
        day["tibo"] = []
    versus["days"][0]["tibo"] = [{"number": "1.1", "summary": "QA fixture: one listed improvement.",
                                  "tweetUrl": "https://x.com/thsottiaux/status/1", "status": "improvement"}]
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
        vote_calls = [call for call in mock.calls if call["method"] == "POST"]
        assert len(vote_calls) == 1, vote_calls
        stored = page.evaluate("Object.fromEntries(Object.entries(localStorage).map(([k,v])=>{try{return[k,JSON.parse(v)]}catch{return[k,v]}}))")
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
        vote_calls = [call for call in mock.calls if call["method"] == "POST"]
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
        vote_calls = [call for call in mock.calls if call["method"] == "POST"]
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
        assert len(mock.identities) == 1, "Pacific rollover must retain the same random browser identity."
        passed("PT midnight refresh opens a new daily vote while preserving yesterday's choice and browser identity")
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
    mock.rate_limit = True
    context, page = setup_context(browser, site, configured=True, mock=mock)
    try:
        load(page, site)
        expect(page.locator("#vote-dots")).to_be_enabled()
        page.locator("#vote-dots").click()
        expect(page.locator("#vote-dots")).to_be_disabled()
        expect(page.locator("#poll-status")).to_contain_text("RATE LIMITED")
        assert mock.counts == {"dots": 3, "bots": 1}, mock.counts
        mock.rate_limit = False
        page.locator("#poll-refresh").click()
        expect(page.locator("#poll-status")).to_contain_text("LOCKED IN")
        assert mock.counts == {"dots": 4, "bots": 1}, mock.counts
        passed("Worker rate limit adds no vote; checking status safely retries the same side after recovery")
    finally:
        context.close()

    mock = MockPoll()
    context, page = setup_context(browser, site, configured=True, mock=mock, storage_blocked=True)
    try:
        load(page, site)
        expect(page.locator("#vote-dots")).to_be_disabled()
        expect(page.locator("#poll-status")).to_contain_text(re.compile(r"storage|browser", re.I))
        assert not any(call["method"] == "POST" for call in mock.calls), mock.calls
        passed("Blocked localStorage fails closed before a vote request")
    finally:
        context.close()


def approval_id(day):
    return f"codex-28:{BASE_DATA['days'][day - 1]['date']}:day-{day}"


def approval_node(page, day):
    return page.locator(f'.update-poll[data-poll-id="{approval_id(day)}"]')


def assert_approval_counts(poll, approve, not_convinced):
    expect(poll.locator(".update-poll-total")).to_contain_text(f"{approve + not_convinced} vote")
    expect(poll.locator(".update-poll-approve")).to_contain_text(f"{approve} ·")
    expect(poll.locator(".update-poll-not-convinced")).to_contain_text(f"{not_convinced} ·")


def test_approval(browser, site):
    legacy = MockApprovalPoll()
    context, page = setup_context(browser, site, approval_configured=True, approval_mock=legacy)
    try:
        load(page, site)
        expect(page.locator(".update-poll")).to_have_count(5)
        first = approval_node(page, 1)
        expect(first.locator('[data-choice="approve"]')).to_be_enabled()
        assert_approval_counts(first, 0, 0)
        first.locator('[data-choice="approve"]').focus()
        page.keyboard.press("Enter")
        expect(first.locator(".update-poll-status")).to_contain_text("Your vote: Approve")
        assert_approval_counts(first, 1, 0)
        expect(first.locator('[data-choice="not_convinced"]')).to_be_disabled()
        page.locator("#show-all").click()
        expect(page.locator(".update-poll")).to_have_count(5)
        assert_approval_counts(first, 1, 0)
        expect(approval_node(page, 6)).to_have_count(0)
        expect(approval_node(page, 7)).to_have_count(0)
        page.locator("#show-all").click()
        page.reload(wait_until="networkidle")
        expect(first.locator(".update-poll-status")).to_contain_text("Your vote: Approve")
        assert_approval_counts(first, 1, 0)
        assert len([call for call in legacy.calls if call["method"] == "POST"]) == 1
        passed("Original approval buttons vote by keyboard once; stable day IDs survive reload/timeline toggles and exclude pending/future days")
    finally:
        context.close()

    teams = MockPoll(dots=0, bots=0)
    legacy = MockApprovalPoll()
    context, page = setup_context(browser, site, configured=True, mock=teams,
                                  approval_configured=True, approval_mock=legacy)
    try:
        load(page, site)
        first = approval_node(page, 1)
        expect(first.locator('[data-choice="not_convinced"]')).to_be_enabled()
        first.locator('[data-choice="not_convinced"]').click()
        expect(first.locator(".update-poll-status")).to_contain_text("Your vote: Not convinced")
        expect(page.locator("#vote-dots")).to_be_enabled()
        page.locator("#vote-dots").click()
        expect(page.locator("#poll-status")).to_contain_text("LOCKED IN")
        assert_approval_counts(first, 0, 1)
        assert_counts_and_health(page, 1, 0)
        assert teams.identities == legacy.identities and len(teams.identities) == 1, \
            {"teamIdentities": list(teams.identities), "approvalIdentities": list(legacy.identities)}
        expect(approval_node(page, 2).locator('[data-choice="approve"]')).to_be_enabled()
        passed("Approval and team counts/choices stay independent while sharing the preserved browser UUID")
    finally:
        context.close()

    legacy = MockApprovalPoll()
    legacy.lose_response = True
    context, page = setup_context(browser, site, approval_configured=True, approval_mock=legacy)
    try:
        load(page, site)
        first = approval_node(page, 1)
        expect(first.locator('[data-choice="approve"]')).to_be_enabled()
        first.locator('[data-choice="approve"]').click()
        expect(first.locator(".update-poll-status")).to_contain_text("Vote unconfirmed")
        expect(first.locator('[data-choice="not_convinced"]')).to_be_disabled()
        page.locator("#show-all").click()
        expect(first.locator(".update-poll-retry-vote")).to_be_visible()
        first.locator(".update-poll-retry-vote").click()
        expect(first.locator(".update-poll-status")).to_contain_text("Your vote: Approve")
        assert_approval_counts(first, 1, 0)
        posts = [call for call in legacy.calls if call["method"] == "POST"]
        assert len(posts) == 2 and posts[0]["body"] == posts[1]["body"], posts
        passed("Original approval lost response retains its same-choice retry across timeline rerender without double counting")
    finally:
        context.close()

    legacy = MockApprovalPoll()
    legacy.fail_reads = True
    context, page = setup_context(browser, site, width=390, height=844,
                                  approval_configured=True, approval_mock=legacy)
    try:
        load(page, site)
        first = approval_node(page, 1)
        expect(first.locator(".update-poll-status")).to_contain_text("Shared results could not be loaded")
        expect(first.locator(".update-poll-results")).to_be_hidden()
        expect(first.locator('[data-choice="approve"]')).to_be_disabled()
        legacy.fail_reads = False
        first.locator(".update-poll-refresh").click()
        expect(first.locator('[data-choice="approve"]')).to_be_enabled()
        metrics = first.locator("button:visible").evaluate_all("bs => bs.map(b=>({width:b.getBoundingClientRect().width,height:b.getBoundingClientRect().height}))")
        assert all(item["width"] >= 44 and item["height"] >= 44 for item in metrics), metrics
        assert page.evaluate("document.documentElement.scrollWidth") <= 390
        assert_approval_counts(first, 0, 0)
        passed("390px original approval errors show no invented count, recover via retry, and preserve 44px controls without overflow")
    finally:
        context.close()

    # Hold both services' configs until two fresh tabs have requested them.
    # Releasing all four together deterministically exercises shared-ID startup.
    teams = MockPoll(dots=0, bots=0)
    legacy = MockApprovalPoll()
    context, first = setup_context(browser, site, configured=True, mock=teams,
                                   approval_configured=True, approval_mock=legacy)
    second = context.new_page()
    second.on("pageerror", lambda error: REPORT["pageErrors"].append(str(error)))
    waiting_configs = []

    def release_configs(route):
        waiting_configs.append(route)
        assert len(waiting_configs) <= 4, "Each service config must load only once per fresh tab."
        if len(waiting_configs) == 4:
            for held in waiting_configs:
                held.fulfill(status=200, content_type="application/json", body=json.dumps(CONFIG))

    context.route(re.compile(r"/(?:versus|voting)-config\.json(?:\?|$)"), release_configs)
    try:
        first.goto(site, wait_until="domcontentloaded")
        second.goto(site, wait_until="domcontentloaded")
        for page in (first, second):
            expect(page.locator("#vote-dots")).to_be_enabled()
            expect(approval_node(page, 1).locator('[data-choice="approve"]')).to_be_enabled()
        first_id = first.evaluate("localStorage.getItem('codex-28-voter-id-v1')")
        second_id = second.evaluate("localStorage.getItem('codex-28-voter-id-v1')")
        assert first_id and first_id == second_id
        assert teams.identities == legacy.identities == {first_id}, \
            {"teamIdentities": list(teams.identities), "approvalIdentities": list(legacy.identities)}
        assert len(waiting_configs) == 4
        passed("Two fresh tabs released together initialize one preserved UUID for both poll systems through their shared Web Lock")
    finally:
        context.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--no-screenshots", action="store_true", help="Run checks without overwriting final visual artifacts")
    parser.add_argument("--only", choices=("visuals", "controls", "data", "time", "poll", "approval"), help="Run one group while fixing a failure")
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
                if args.only in (None, "approval"):
                    test_approval(browser, site)
                assert not REPORT["pageErrors"], REPORT["pageErrors"]
                assert not REPORT["unexpectedRequests"], REPORT["unexpectedRequests"]
                passed("No JavaScript exceptions, live Worker calls, or unexpected external requests")
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
