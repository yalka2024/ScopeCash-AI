# Manual assistive-technology testing protocol

What's automated (`public-pages.spec.cjs`, `authenticated-pages.spec.cjs`) is
real and catches a real class of bugs — this session alone found and fixed 16
distinct issues across both suites, several severe (the entire authenticated
nav was unreachable by keyboard; large parts of the app rendered near-white
text on a white/near-white background). But axe-core is a static DOM/CSS
analyzer. It cannot tell you whether a screen reader's actual spoken output
makes sense, whether focus order matches visual/reading order, or whether an
interaction is *usable*, only whether specific machine-checkable rules are
violated. Industry estimates put automated coverage at roughly 30-50% of real
WCAG issues. This document is the checklist for the remaining half — it
requires an actual human, with actual assistive technology, actually
listening to actual output. No agent can substitute for that here, honestly.

## What you need

- **Windows**: NVDA (free, https://www.nvidia.com/... — no, https://www.nvaccess.org/) + Chrome or Firefox. JAWS if you have a license.
- **Mac**: VoiceOver (built in, Cmd+F5) + Safari.
- Keyboard only for part of this — physically avoid touching the mouse/trackpad for the keyboard-only sections.
- ~60-90 minutes for a first full pass; ~20 minutes for a re-check after UI changes.

## Setup

1. Run the app locally with a real account (see main README for `docker
   compose up` or local dev instructions) — don't test against a demo/seed
   account with no real data if you can help it; screen readers announce
   empty-state UI differently than populated tables.
2. Turn on your screen reader before opening the browser tab, so the very
   first page load is captured.

## Part 1 — Keyboard only (mouse/trackpad untouched)

Do this section for BOTH the public marketing pages and the authenticated
dashboard.

- [ ] From the address bar, `Tab` through the entire public landing page.
      Every interactive element (nav links, "Start free", pricing links,
      footer links, cookie-consent buttons) should receive a visible focus
      ring, in an order that matches how the page reads visually.
- [ ] Reach and operate the cookie-consent banner (Accept/Reject/Customize)
      using only `Tab` and `Enter`/`Space`.
- [ ] On the sign-in page, `Tab` to the "Don't have an account? Register"
      toggle and activate it with `Enter` — confirm the form actually
      switches to registration fields (this exact control was mouse-only
      until this session's pass; it's now a real `<button>`, verify it
      stayed that way).
- [ ] Log in, then `Tab` through the ENTIRE sidebar nav (Projects → Evidence
      → ... → Help centre) without touching the mouse. Every item should
      focus visibly and activate with `Enter`. Confirm you can reach every
      single nav item — don't stop at the first few.
- [ ] On a page with a data table (Projects, Packets, or similar), find a
      table wide enough to scroll horizontally. Tab to it and use arrow
      keys to scroll it without a mouse.
- [ ] Open any modal/dialog in the app (if one exists in your build) and
      confirm: focus moves into it automatically, `Tab` cannot escape it
      to the page behind it (no keyboard trap in the wrong direction —
      i.e. focus should stay inside the dialog until closed), and `Escape`
      or a visible close control returns focus to a sensible place.
- [ ] Confirm there is no point in either the public site or the dashboard
      where focus becomes genuinely stuck (same element re-focuses no
      matter how many times you press `Tab`/`Shift+Tab`).

## Part 2 — Screen reader walkthrough

Turn on NVDA/VoiceOver/JAWS for this section; keep your eyes on the screen
too so you can compare what's announced against what's visible.

- [ ] Landing page: does the page title, the main heading, and the primary
      CTA get announced in a sensible order? Are decorative icons/emoji
      silent (not read aloud as "graphic" or garbage) unless they carry
      real meaning?
- [ ] Sign-in / register: are both the "Email" and "Password" fields
      announced with their labels (not just "edit text")? Is a failed
      login's error message announced automatically (it uses
      `role="alert"` — confirm you actually HEAR it without having to
      navigate to it manually)?
- [ ] First-run setup wizard (if testing a fresh instance): is the
      password-strength hint announced when the field is focused? Are the
      six checklist steps read as a genuine ordered/list structure, not a
      wall of unstructured text?
- [ ] Authenticated sidebar: does the screen reader announce each item as
      a "button" (not silently skip past it, which is what happened before
      this session's fix)? Does it announce which page is currently active
      (the app now sets `aria-current="page"` on the active nav item —
      confirm your screen reader actually says "current page" or similar)?
- [ ] Any data table (Projects, Evidence, etc.): does the screen reader
      announce column headers when you move through data cells (e.g. "Name,
      column 2" not just the bare cell value)? Can you navigate table rows
      with your screen reader's table-navigation keys (NVDA: Ctrl+Alt+arrows;
      VoiceOver: VO+arrows inside a table)?
- [ ] The Competition Evidence Center's revenue/evidence log forms: are all
      inputs (classification dropdown, period, amount, source) announced
      with real labels, and does a successful submit get announced (toast/
      confirmation), not just silently update the page?
- [ ] Any status/health badge (Tools page "live/mock/unimplemented", Status
      page "operational/degraded"): is the STATUS WORD itself announced
      (not just an unlabeled colored shape)? Color alone must never be the
      only signal — confirm the text label is really there for the screen
      reader, not just visually.

## Part 3 — Zoom / reflow

- [ ] Set browser zoom to 200%. Confirm no text is clipped/overlapping and
      no horizontal scrollbar appears on the PAGE itself (individual data
      tables scrolling horizontally is fine and expected).
- [ ] Set zoom to 400% (WCAG 1.4.10 Reflow target). The layout may
      reasonably stack/reflow, but no content or functionality should be
      lost.

## Recording results

For each failed item above, capture: the exact page/URL, what you did, what
you expected, what actually happened (verbatim announcement if a screen
reader issue), and your OS/browser/AT combination. File as a normal bug —
these are real product bugs, not different in kind from the ones caught by
the automated suite.

## What this protocol does NOT cover

- Cognitive/plain-language review (a separate discipline).
- Testing with actual users who rely on AT day-to-day, which surfaces
  usability issues no amount of expert manual testing fully replicates.
- Mobile screen readers (TalkBack/VoiceOver-iOS) — this app doesn't
  currently target a distinct mobile experience.
