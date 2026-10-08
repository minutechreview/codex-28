#!/usr/bin/env python3
"""Browser integration checks against the local persistent voting API.

Run through `npm run test:voting-browser`, which starts isolated local servers.
Browser config/data interception is test-only; public data/config is never edited.
Requires the existing Python Playwright installation and Chromium.
"""

import copy
import json
import os
from pathlib import Path
import re
from urllib.parse import urlsplit

from playwright.sync_api import sync_playwright, expect


ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "output" / "voting"
SITE = os.environ.get("VOTING_SITE_URL", "http://127.0.0.1:4173")
API = os.environ.get("VOTING_API_URL", "http://127.0.0.1:8787")
ORIGIN = f"{urlsplit(SITE).scheme}://{urlsplit(SITE).netloc}"
BASE_DATA = json.loads((ROOT / "data.json").read_text())
NOW = "2026-10-08T20:09:00.000Z"
REPORT = {"checks": [], "screenshots": [], "consoleErrors": [], "pageErrors": []}


def passed(name, detail=None):
    item = {"name": name, "passed": True}
    if detail is not None:
        item["detail"] = detail
    REPORT["checks"].append(item)
    print(f"PASS {name}", flush=True)


def freeze_time(context, now=NOW):
    context.add_init_script("""(() => {
      const OriginalDate = Date;
      window.__qaNow = OriginalDate.parse(%s);
      window.Date = class extends OriginalDate {
        constructor(...args) { super(...(args.length ? args : [window.__qaNow])); }
        static now() { return window.__qaNow; }
      };
    })();""" % json.dumps(now))


def collect_errors(page):
    page.on("pageerror", lambda error: REPORT["pageErrors"].append(str(error)))
    page.on("console", lambda message: REPORT["consoleErrors"].append(message.text)
            if message.type == "error" else None)


def setup_context(browser, *, now=NOW, fixture=None, config=True,
                  width=1280, height=1000, touch=False, storage_blocked=False):
    context = browser.new_context(viewport={"width": width, "height": height},
                                  is_mobile=touch, has_touch=touch)
    freeze_time(context, now)
    # Always route the local test's service config. The null-config case is an
    # explicit test fixture now that the real release has a production endpoint.
    context.route("**/voting-config.json*", lambda route: route.fulfill(
        status=200, content_type="application/json",
        body=json.dumps({"apiBaseUrl": API if config else None})))
    if fixture is not None:
        context.route("**/data.json*", lambda route: route.fulfill(
            status=200, content_type="application/json", body=json.dumps(fixture)))
    if storage_blocked:
        context.add_init_script("""(() => {
          Storage.prototype.getItem = () => { throw new DOMException('Storage blocked', 'SecurityError'); };
          Storage.prototype.setItem = () => { throw new DOMException('Storage blocked', 'SecurityError'); };
        })();""")
    return context


def poll_id(day):
    return f"codex-28:{BASE_DATA['days'][day - 1]['date']}:day-{day}"


def api_result(context, day, voter_id=None):
    from urllib.parse import quote
    endpoint = API + "/polls/" + quote(poll_id(day), safe="")
    if voter_id:
        endpoint += "?voterId=" + voter_id
    response = context.request.get(endpoint, headers={"Origin": ORIGIN})
    assert response.ok, f"Unexpected API response {response.status}: {response.text()}"
    return response.json()


def screenshot(page, name):
    path = OUT / name
    # Reset the viewport before a full-page capture so offscreen fixed controls
    # such as the existing skip link do not appear midway through the image.
    page.evaluate("() => { document.activeElement?.blur(); window.scrollTo({top: 0, left: 0, behavior: 'instant'}); }")
    page.wait_for_function("window.scrollY === 0")
    page.screenshot(path=str(path), full_page=True)
    REPORT["screenshots"].append(str(path.relative_to(ROOT)))


def load(page):
    page.goto(SITE, wait_until="networkidle")
    expect(page.locator("#day-strip .day-button")).to_have_count(28)


def select_day(page, day):
    page.locator(f'.day-button[data-day="{day}"]').click()
    expect(page.locator("#day-detail")).to_contain_text(f"Day {day}")


def assert_artwork(page):
    assert page.locator(".dot-character img").evaluate_all(
        "images => images.length === 4 && images.every(img => img.complete && img.naturalWidth > 0)"
    ), "Original artwork failed to load"


def main():
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        try:
            # This run starts with a fresh real SQLite database, managed by the wrapper.
            first = setup_context(browser)
            page = first.new_page()
            collect_errors(page)
            load(page)
            assert_artwork(page)
            expect(page.locator("#today-poll")).to_have_attribute("data-poll-id", poll_id(4))
            assert_counts(page.locator("#today-poll"), 0, 0)
            expect(page.locator("#day-poll")).to_be_hidden()
            expect(page.locator("#today-summary")).to_have_text(BASE_DATA["days"][3]["summary"])
            passed("Owner's published day4 opens today's poll; original update and artwork load")

            for day in (1, 2, 3):
                select_day(page, day)
                poll = page.locator("#day-poll")
                expect(poll).to_have_attribute("data-poll-id", poll_id(day))
                expect(poll.locator(".poll-total")).to_have_text("0 votes · shared results")
                expect(poll.locator('[data-choice="approve"]')).to_be_enabled()
            select_day(page, 4)
            expect(page.locator("#day-poll")).to_be_hidden()
            expect(page.locator("#today-poll")).to_have_attribute("data-poll-id", poll_id(4))
            select_day(page, 5)
            expect(page.locator("#day-poll")).to_be_hidden()
            expect(page.locator(f'.visitor-poll[data-poll-id="{poll_id(5)}"]')).to_have_count(0)
            expect(page.locator("#day-detail")).to_contain_text("Voting opens")
            passed("Published days 1–4 have separate stable polls; pending day5 has no poll")

            select_day(page, 1)
            poll = page.locator("#day-poll")
            poll.locator('[data-choice="approve"]').click()
            expect(poll.locator(".poll-status")).to_contain_text("Your vote: Approve")
            assert_counts(poll, 1, 0)
            voter_id = page.evaluate("localStorage.getItem('codex-28-voter-id-v1')")
            assert voter_id and api_result(first, 1, voter_id)["yourVote"] == "approve"
            assert page.evaluate("Object.keys(localStorage)") == ["codex-28-voter-id-v1"], \
                "Browser storage must not contain authoritative vote counts"
            page.reload(wait_until="networkidle")
            select_day(page, 1)
            assert_counts(poll, 1, 0)
            expect(poll.locator('[data-choice="approve"]')).to_be_disabled()
            expect(poll.locator('[data-choice="not_convinced"]')).to_be_disabled()
            passed("Vote persists through refresh; browser stores only an identifier")

            same_browser = first.new_page()
            collect_errors(same_browser)
            load(same_browser)
            select_day(same_browser, 1)
            expect(same_browser.locator("#day-poll .poll-status")).to_contain_text("Your vote: Approve")
            expect(same_browser.locator('#day-poll [data-choice="not_convinced"]')).to_be_disabled()
            assert api_result(first, 1)["total"] == 1
            same_browser.close()
            passed("Another tab in the same browser sees the recorded choice without adding a vote")

            second = setup_context(browser)
            other = second.new_page()
            collect_errors(other)
            load(other)
            select_day(other, 1)
            other.locator('#day-poll [data-choice="not_convinced"]').click()
            expect(other.locator("#day-poll .poll-status")).to_contain_text("Your vote: Not convinced")
            assert_counts(other.locator("#day-poll"), 1, 1)
            poll.locator(".poll-refresh").click()
            assert_counts(poll, 1, 1)
            assert api_result(first, 1)["total"] == 2
            screenshot(page, "desktop-history-shared-results.png")
            passed("Separate browsers share persistent counts and percentages", {"day1": {"approve": 1, "notConvinced": 1, "total": 2}})

            # Roving day navigation followed by a keyboard-only vote.
            day_one = page.locator('.day-button[data-day="1"]')
            day_one.focus()
            page.keyboard.press("ArrowRight")
            day_two = page.locator('.day-button[data-day="2"]')
            expect(day_two).to_be_focused()
            expect(day_two).to_have_attribute("aria-pressed", "true")
            expect(poll.locator('[data-choice="approve"]')).to_be_enabled()
            page.keyboard.press("Tab")
            expect(page.locator("#day-detail a")).to_be_focused()
            page.keyboard.press("Tab")
            expect(poll.locator('[data-choice="approve"]')).to_be_focused()
            assert poll.locator('[data-choice="approve"]').evaluate(
                "b => { const s = getComputedStyle(b); return s.outlineStyle !== 'none' && parseFloat(s.outlineWidth) >= 2; }")
            page.keyboard.press("Enter")
            expect(poll.locator(".poll-status")).to_contain_text("Your vote: Approve")
            assert_counts(poll, 1, 0)
            select_day(page, 1)
            assert_counts(poll, 1, 1)
            select_day(page, 2)
            assert_counts(poll, 1, 0)
            passed("Arrow-key day navigation and Enter voting work; historical polls retain separate results")

            edited = copy.deepcopy(BASE_DATA)
            today_context = setup_context(browser, now="2026-10-07T20:09:00.000Z", fixture=edited)
            today_page = today_context.new_page()
            collect_errors(today_page)
            load(today_page)
            today_poll = today_page.locator("#today-poll")
            expect(today_poll).to_have_attribute("data-poll-id", poll_id(3))
            expect(today_page.locator("#day-poll")).to_be_hidden()
            today_poll.locator('[data-choice="approve"]').click()
            expect(today_poll.locator(".poll-status")).to_contain_text("Your vote: Approve")
            assert_counts(today_poll, 1, 0)
            screenshot(today_page, "desktop-published-today.png")
            edited["days"][2]["summary"] = "Same day content correction for browser QA."
            edited["days"][2]["status"] = "improvement"
            today_page.locator("#retry").click()
            expect(today_page.locator("#today-summary")).to_have_text(edited["days"][2]["summary"])
            expect(today_poll).to_have_attribute("data-poll-id", poll_id(3))
            assert_counts(today_poll, 1, 0)
            today_page.evaluate("""() => {
              window.__qaNow = Date.parse('2026-10-08T20:09:00.000Z');
              document.dispatchEvent(new Event('visibilitychange'));
            }""")
            expect(today_page.locator("#day-number")).to_have_text("04")
            expect(today_poll).to_have_attribute("data-poll-id", poll_id(4))
            assert_counts(today_poll, 0, 0)
            expect(today_page.locator("#today-summary")).to_have_text(BASE_DATA["days"][3]["summary"])
            expect(today_page.locator("#day-poll")).to_have_attribute("data-poll-id", poll_id(3))
            assert_counts(today_page.locator("#day-poll"), 1, 0)
            passed("Same-day edits retain results; Pacific rollover opens owner's day4 poll while preserving day3 history")

            future_data = copy.deepcopy(BASE_DATA)
            future_data["days"][4].update(status="improvement", summary="Future fixture, never published by this test.")
            future_context = setup_context(browser, fixture=future_data)
            future_page = future_context.new_page()
            collect_errors(future_page)
            load(future_page)
            select_day(future_page, 5)
            expect(future_page.locator("#day-poll")).to_be_hidden()
            passed("Future day has no poll even if a client fixture contains an outcome")

            # Lose the response only after the real API commits the vote.
            ambiguous = setup_context(browser)
            uncertain = ambiguous.new_page()
            collect_errors(uncertain)
            load(uncertain)
            select_day(uncertain, 2)
            uncertain_poll = uncertain.locator("#day-poll")
            assert_counts(uncertain_poll, 1, 0)
            attempted = []

            def lost_response(route):
                if route.request.method != "POST":
                    route.continue_()
                    return
                attempted.append(route.request.post_data_json)
                if len(attempted) == 1:
                    committed = route.fetch()
                    assert committed.ok, "The lost response must follow a real committed vote"
                    route.abort("failed")
                else:
                    route.continue_()

            uncertain.route("**/polls/**", lost_response)
            uncertain_poll.locator('[data-choice="not_convinced"]').click()
            expect(uncertain_poll.locator(".poll-status")).to_contain_text("It may have been saved")
            expect(uncertain_poll.locator('[data-choice="approve"]')).to_be_disabled()
            expect(uncertain_poll.locator('[data-choice="not_convinced"]')).to_be_disabled()
            uncertain_id = uncertain.evaluate("localStorage.getItem('codex-28-voter-id-v1')")
            stored = api_result(ambiguous, 2, uncertain_id)
            assert stored["total"] == 2 and stored["yourVote"] == "not_convinced"
            uncertain_poll.locator(".poll-retry-vote").click()
            expect(uncertain_poll.locator(".poll-status")).to_contain_text("Your vote: Not convinced")
            assert_counts(uncertain_poll, 1, 1)
            assert len(attempted) == 2 and attempted[0] == attempted[1]
            assert api_result(ambiguous, 2)["total"] == 2
            passed("Lost POST response retries the original choice idempotently after real database commit")

            unavailable = setup_context(browser)
            failed = unavailable.new_page()
            collect_errors(failed)

            def failed_get(route):
                if route.request.method == "GET":
                    route.fulfill(status=503, content_type="application/json",
                                  headers={"Access-Control-Allow-Origin": ORIGIN},
                                  body=json.dumps({"error": {"code": "test_unavailable"}}))
                else:
                    route.continue_()

            failed.route("**/polls/**", failed_get)
            load(failed)
            select_day(failed, 3)
            failed_poll = failed.locator("#day-poll")
            expect(failed_poll.locator(".poll-status")).to_contain_text("Shared results could not be loaded")
            expect(failed_poll.locator(".poll-results")).to_be_hidden()
            expect(failed_poll.locator('[data-choice="approve"]')).to_be_disabled()
            assert "0 votes" not in failed_poll.inner_text()
            failed.unroute("**/polls/**", failed_get)
            failed_poll.locator(".poll-refresh").click()
            assert_counts(failed_poll, 1, 0)
            failed.route("**/polls/**", failed_get)
            failed_poll.locator(".poll-refresh").click()
            expect(failed_poll.locator(".poll-status")).to_contain_text("last loaded results")
            expect(failed_poll.locator(".poll-total")).to_have_text("1 vote · last loaded results")
            screenshot(failed, "desktop-results-unavailable.png")
            passed("GET failure shows no fabricated zero; recovery works and stale counts are explicitly labeled")

            blocked = setup_context(browser, storage_blocked=True)
            blocked_page = blocked.new_page()
            collect_errors(blocked_page)
            load(blocked_page)
            select_day(blocked_page, 1)
            blocked_poll = blocked_page.locator("#day-poll")
            assert_counts(blocked_poll, 1, 1)
            expect(blocked_poll.locator(".poll-status")).to_contain_text("voting needs browser storage")
            expect(blocked_poll.locator('[data-choice="approve"]')).to_be_disabled()
            expect(blocked_poll.locator('[data-choice="not_convinced"]')).to_be_disabled()
            passed("Blocked browser storage disables voting while retaining readable shared results")

            no_config = setup_context(browser, config=False)
            no_config_page = no_config.new_page()
            collect_errors(no_config_page)
            load(no_config_page)
            select_day(no_config_page, 1)
            closed_poll = no_config_page.locator("#day-poll")
            expect(closed_poll.locator(".poll-status")).to_contain_text("Voting is not available yet")
            expect(closed_poll.locator(".poll-results")).to_be_hidden()
            expect(closed_poll.locator(".poll-choices")).to_be_hidden()
            assert "0 votes" not in closed_poll.inner_text()
            passed("Test-only null service config presents an honest unavailable state with no pretend results")

            mobile_metrics = []
            for width in (320, 390):
                mobile = setup_context(browser, width=width, height=844, touch=True)
                mobile_page = mobile.new_page()
                collect_errors(mobile_page)
                load(mobile_page)
                assert_artwork(mobile_page)
                select_day(mobile_page, 1)
                assert_counts(mobile_page.locator("#day-poll"), 1, 1)
                overflow = mobile_page.evaluate("document.documentElement.scrollWidth > window.innerWidth")
                assert not overflow, f"Page overflows horizontally at {width}px"
                metrics = mobile_page.locator('#day-poll button:visible').evaluate_all(
                    "buttons => buttons.map(b => ({text:b.textContent, width:b.getBoundingClientRect().width, height:b.getBoundingClientRect().height}))")
                assert all(item["height"] >= 44 and item["width"] >= 44 for item in metrics), metrics
                mobile_metrics.append({"viewport": width, "pollButtons": metrics, "horizontalOverflow": overflow})
                screenshot(mobile_page, f"mobile-{width}-shared-results.png")
                mobile.close()
            passed("320px/390px mobile views preserve artwork, avoid overflow, and have 44px poll touch targets", mobile_metrics)

            assert not REPORT["pageErrors"], REPORT["pageErrors"]
            # Network console errors are expected only in the explicit failure scenarios.
            unexpected = [message for message in REPORT["consoleErrors"]
                          if not re.search(r"Failed to load resource.*(?:ERR_FAILED|503)", message)]
            assert not unexpected, unexpected
            passed("No uncaught browser errors; only deliberate unavailable/lost-response network errors")
            REPORT["browser"] = browser.version
        finally:
            browser.close()


def assert_counts(poll, approve, not_convinced):
    total = approve + not_convinced
    first_percent = int(approve / total * 100 + .5) if total else 0
    second_percent = 100 - first_percent if total else 0
    expect(poll.locator(".poll-total")).to_have_text(f"{total} vote{'s' if total != 1 else ''} · shared results")
    expect(poll.locator(".poll-approve")).to_have_text(f"{approve} · {first_percent}%")
    expect(poll.locator(".poll-not-convinced")).to_have_text(f"{not_convinced} · {second_percent}%")


if __name__ == "__main__":
    OUT.mkdir(parents=True, exist_ok=True)
    try:
        main()
        REPORT["passed"] = True
    except Exception as error:
        REPORT["passed"] = False
        REPORT["failure"] = str(error)
        raise
    finally:
        (OUT / "browser-report.json").write_text(json.dumps(REPORT, indent=2) + "\n")
