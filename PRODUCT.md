# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users
Elgato Stream Deck users in Athens, Greece, who commute using the OASA public transit system and need a quick, glanceable way to check live bus arrival times from their desk without opening a browser or phone app.

## Product Purpose
A Stream Deck plugin that provides live OASA bus arrivals on a physical stream deck button. The settings UI (Property Inspector) allows the user to configure multiple bus stops, filter specific bus lines, customize the visual colors of the lines on the button, and set custom text overrides.

## Positioning
A dedicated hardware-integrated transit tracker for Athens buses, bridging the OASA Telematics API with Elgato's Stream Deck ecosystem for frictionless, always-on tracking.

## Operating Context
- Runs inside the Elgato Stream Deck application's Chromium webview (Property Inspector).
- Users interact with this UI to configure their hardware keys.
- Requires high contrast, legible UI that fits the dark mode aesthetic of the Stream Deck app.

## Capabilities and Constraints
- The UI is built using the official `@elgato/streamdeck` and `sdpi-components.js` web components.
- The UI is limited to the Property Inspector side panel (narrow width, scrollable).
- Fields include Primary Stop Code, multiple Secondary Stops, Line Filters, Color pickers, and a Textarea for Line Overrides.
- Has a dummy data toggle for testing.
- Button controls: Short Press (scroll), Double Tap (cycle stops), Long Press (refresh).

## Brand Commitments
- Maintains the Elgato Stream Deck dark mode aesthetic.
- OASA Bus theme (using typical blue/orange bus colors as defaults: `#004A77`, `#E3963E`).

## Evidence on Hand
- `com.miketsakgr.oasa-bus.sdPlugin/manifest.json` indicates minimum Stream Deck v7.1 and SDK v3.
- `bus-arrival.html` contains the existing Property Inspector UI with `sdpi-item` components and basic CSS.

## Product Principles
- **Streamlined Configuration**: Making it effortless to paste stop codes and configure lines.
- **Native Feel**: The settings page should feel like a built-in part of the Elgato Stream Deck app.
- **Clear Feedback**: Explaining overrides and controls clearly so users don't have to guess how the physical button behaves.
