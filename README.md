# OASA Bus Arrivals - Stream Deck Plugin 🚌

A powerful, sleek, and highly customizable Stream Deck plugin for tracking live bus arrivals in Athens (OASA Telematics). Get real-time updates directly on your Stream Deck buttons with beautiful OLED-optimized SVG rendering, multi-stop cycling, scheduled departure fallbacks, and custom color-coded line overrides.

---

## Features

- 🕒 **Live ETAs & Smart Polling**: Fetches real-time bus arrivals straight from OASA Telematics via secure HTTPS every 90 seconds (1:30 min) with zero glitching or screen flickering on background updates.
- 📅 **Scheduled Fallback**: If no live bus is currently en route, the plugin automatically fetches and displays the upcoming scheduled terminal departures.
- 🎨 **Visual Customization**: Dynamically override line colors and badges (e.g., color-code express lines, trolley lines, or specific bus routes).
- 🔄 **Multi-Stop Support**: Configure up to 5 different stops on a single key.
- 📱 **Smooth Pagination**: Automatically paginates if more than 2 buses are arriving. Short-press the key to smoothly scroll to the next page.
- ⏳ **Seamless Background Updates**: Background polls refresh data in place without interrupting your view. A clean spinner only appears on initial launch, stop changes, or when the API takes longer to respond.
- ⚡ **Hold-to-Refresh**: Hold the button for 5 seconds to trigger an instant hard refresh with an animated progress ring.
- 📊 **Status & Freshness Bar**: Displays a live timestamp and freshness dot (LIVE / STALE) on the bottom edge.
- 🔧 **Dummy Mode**: Built-in toggle to test animations, layout, and colors without needing active bus data.

---

## Installation

1. Download the latest `.streamDeckPlugin` file from [Releases](https://github.com/MikeTsak/oasa-Stream-Deck/releases).
2. Double-click the file to install it directly into the Elgato Stream Deck software.
3. Drag and drop the **OASA Bus** action onto your canvas.

---

## Configuration & Usage

Configure your widget directly inside the Stream Deck **Property Inspector**:

### 1. Stop Codes
- **Primary Stop Code**: Enter your 6-digit stop code from the OASA Telematics app / website (e.g., `070106`).
- **Secondary Stops**: Add up to 4 additional stop codes. **Double-tap** the Stream Deck button to cycle between your saved stops instantly.

### 2. Line Filters
Only interested in specific buses at a multi-line stop? Enter a comma-separated list of line IDs (e.g., `856, 750, A15`) to filter out everything else.

### 3. Line Overrides
Customize line colors and badge text using the `LineID,Color,CustomText` format (one entry per line):

```csv
856,#00E5FF,856
750,#FF6B00,ΑΤΤΙΚΟ
049,#004A77,ΠΕΙΡΑΙΑΣ
```

---

## Controls Summary

| Action | Gesture | Description |
|---|---|---|
| **Paginate** | **Short Press (Single Tap)** | Smoothly scrolls to the next page of arrivals |
| **Switch Stop** | **Double Tap** | Cycles to the next configured stop code |
| **Hard Refresh** | **Long Press (Hold 5s)** | Shows an animated progress ring and triggers an immediate API fetch |

---

## Development & Build

Built with TypeScript, Rollup, and standard SVG rendering with zero heavy dependencies.

```bash
# Install dependencies
npm install

# Watch mode for development (auto-restarts Stream Deck plugin on build)
npm run watch

# Production build
npm run build

# Package into .streamDeckPlugin
npm run pack
```

---

*Made with ❤️ by [MikeTsak](https://miketsak.gr)*
