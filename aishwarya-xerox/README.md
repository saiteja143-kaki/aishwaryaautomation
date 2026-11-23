# 🖨️ Aishwarya Xerox – Smart Self-Service Printing Kiosk (Trial Version)

A complete self-service printing kiosk system built specifically for **Aishwarya Xerox**. Customers scan a dynamic QR code outside the shop, upload documents, choose print settings (Single/Double Sided, B&W/Color, Copies), pay via UPI, and the order prints directly on your shop's Canon LAN printer!

---

## 🏗️ Architecture Overview

- **Cloud VPS Server**: Hosts the backend, document processor, pricing engine, outside display view, mobile app, and shop admin dashboard.
- **Shop PC Print Agent**: Runs in the background on your shop PC connected to your Canon printer via Ethernet LAN.
- **Outside TV/Screen**: Displays live QR code and status (`READY TO PRINT` vs `IN USE - PLEASE WAIT`).
- **Sequential Session Lock**: Only 1 customer can use the kiosk at a time during this trial phase, keeping order pickup clean and preventing mix-ups.

---

## 🚀 Quick Start Guide

### Step 1: Run the Main Server (On your VPS or PC)
```bash
cd aishwarya-xerox
npm start
```
By default, the server runs on port `3000`:
- **Portal Switcher**: [http://localhost:3000](http://localhost:3000)
- **Customer Mobile View**: [http://localhost:3000/mobile](http://localhost:3000/mobile)
- **Outside Display Screen (TV)**: [http://localhost:3000/kiosk](http://localhost:3000/kiosk)
- **Shop Owner Admin Panel**: [http://localhost:3000/admin](http://localhost:3000/admin)

---

### Step 2: Run the Shop PC Print Agent (Inside the Shop)
On your shop PC connected to the Canon LAN printer:
```bash
cd aishwarya-xerox/print-agent

# Set your VPS address and Canon printer name:
SERVER_URL="http://your-vps-ip:3000" PRINTER_NAME="Canon_imageRUNNER" npm start
```
*(If testing on your PC without a physical printer, the agent automatically runs in simulation mode so you can test end-to-end).*

---

## ⚙️ Features Built-In

1. **One-Customer-at-a-Time Lock**:
   - Customer scans QR → Kiosk changes to `IN_USE`.
   - Outside TV screen informs waiting customers: *"Kiosk in Use. Please wait ~1-2 mins."*
   - Auto-releases after 3 minutes if abandoned, or immediately when print finishes.
   - Shop owner has an emergency `[Force Reset]` button in the Admin panel.

2. **Accurate PDF & Image Processing**:
   - Reads exact page counts automatically from uploaded PDFs using `pdf-lib`.
   - Supports JPG and PNG images.

3. **Duplex (Back-to-Back) Math**:
   - Accurately calculates physical sheets: e.g., 5 pages Back-to-Back = 3 physical sheets.
   - Applies the configurable sheet discount rate.

4. **Dynamic UPI Payments & Trial Mode**:
   - Generates dynamic UPI QR codes (`upi://pay?pa=...&am=...`).
   - Includes an **Instant Test Pay** button for free testing during the pilot phase.

5. **Shop Owner Controls**:
   - Live revenue tracker.
   - 1-Click Rate Card Editor (B&W and Color rates).
   - Order history with `[Reprint]` option.

