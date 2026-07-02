# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## ⚠️ MANDATORY RULE: Keep the in-app Help updated

After **every** change (minor or major) to features or behavior, you MUST update the in-app Help/Guide section (`ROUTES.help` → `renderAdminGuide()` / `renderSalesGuide()` in `server/public/index.html`) in the same commit. A feature change without a matching Help update is an incomplete change.

## Project Overview

CRM ترنم (CRM Taranom) is a wholesale customer management system for a women's clothing manufacturer ("پوشاک ترنم", based in Mashhad). The entire application lives in a **single file**: `index.html`. There is no build process, package manager, or test suite — edit the file and open it in a browser.

## Running the App

Open `index.html` directly in a browser, or serve it via any static file server:

```bash
# Python
python3 -m http.server 8080

# Node (npx)
npx serve .
```

No compilation step. No dependencies to install.

## Architecture

The file is structured in three contiguous sections:

1. **CSS** (`<style>` block, lines ~11–191) — All styling using CSS custom properties (`--purple`, `--green`, etc.) defined in `:root`.
2. **HTML** (lines ~192–567) — Five tab pages (`dash`, `customers`, `orders`, `followups`, `invoices`) plus five modals (customer, order, followup, invoice, viewinv) and a confirm-delete dialog.
3. **JavaScript** (`<script>` block, lines ~568–1319) — All logic: Firebase init, CRUD operations, render functions, and UI helpers.

### Data Layer: Firebase + LocalStorage Fallback

- **Firebase Firestore** (compat SDK v10.7.1) is the primary store. Credentials are hardcoded in `FB_CONFIG` (lines ~572–581). Real-time `onSnapshot` listeners keep the four in-memory arrays (`customers`, `orders`, `followups`, `invoices`) synced.
- If Firebase fails to init, `USE_FIREBASE` stays `false` and the app operates in offline mode, persisting to `localStorage` under keys `crm_c`, `crm_o`, `crm_f`, `crm_i`.
- The sync indicator dot (`#syncDot`) is green when Firebase is connected, amber when offline.

### In-Memory State

Four global arrays are the single source of truth at runtime:
- `customers` — business name, owner, city, phone, Instagram, type, status
- `orders` — linked to `custId`, includes quantities, totals, paid amounts, delivery dates
- `followups` — linked to `custId`, tracks contact type, subject, priority, next follow-up date
- `invoices` — linked to `custId`, line-item rows with per-item pricing, discount percentage, totals

### Key Conventions

- **Customer statuses**: `vip`, `active`, `followup`, `silent`, `new`
- **Order statuses**: `pending`, `onway`, `done`, `cancel`
- **Followup statuses**: `open`, `done`, `cancel`; priorities: `high`, `mid`, `low`
- **Invoice types**: `proforma` (پیش‌فاکتور), `final` (فاکتور رسمی); numbered as `T-0001`, `T-0002`, …
- **IDs**: Generated with `uid(prefix)` → `prefix + '-' + Date.now().toString(36)` in offline mode; Firestore auto-IDs when online.
- **Dates**: Persian (Jalali) calendar strings entered manually by the user (e.g. `1403/04/01`). No date parsing library is used.
- **Currency**: All amounts in Iranian Toman. Displayed with `fmt(n)` which calls `Number.toLocaleString('fa-IR')`.

### UI Patterns

- Tab switching: `showPage(p)` toggles `.active` on both `.tab` and `.page` elements.
- Modals: `openModal(type)` / `closeModal(type)` toggle the `.open` class on `.overlay` elements. Backdrop click closes the modal.
- CRUD flow: form fields use IDs prefixed by entity abbreviation (`c-` for customer, `o-` for order, `f-` for followup, `inv-` for invoice). A hidden `<input type="hidden">` with the entity's `id` field distinguishes create vs. update.
- `renderAll()` calls all four render functions and conditionally calls `renderDash()`.
- The monthly sales chart uses Chart.js 4.4.1 (CDN). The chart instance is stored in `mChart`; it must be destroyed (`mChart.destroy()`) before recreating to avoid canvas conflicts.
- Invoice print: `window.print()` on the view-invoice modal; CSS `@media print` hides all nav chrome and renders only the invoice preview.
- Font: Vazirmatn (Google Fonts CDN) for Persian text.

## Firebase Collections

| Collection  | Key fields |
|-------------|-----------|
| `customers` | `biz`, `owner`, `city`, `phone`, `insta`, `type`, `status`, `note`, `createdAt` |
| `orders`    | `custId`, `date`, `type`, `qty`, `total`, `paid`, `pay`, `deliver`, `status`, `note`, `createdAt` |
| `followups` | `custId`, `date`, `type`, `subject`, `note`, `action`, `next`, `status`, `priority`, `createdAt` |
| `invoices`  | `custId`, `type`, `date`, `note`, `rows[]`, `subtotal`, `disc`, `discAmt`, `final`, `num`, `createdAt` |

All collections are ordered by `createdAt desc` in their Firestore queries.

## Production Server

- **IP**: `45.90.98.99`
- **SSH port**: `2299`
- **User**: `taranom-admin`
- **SSH key** (client-side, never commit): `C:\Users\DayaTech\.ssh\taranom_server`
- **App path**: `/home/taranom-admin/crm-taranom`
- **Process manager**: PM2, process name `crm-taranom`
- **Branch**: `claude/claude-md-docs-2ssrpy`

Connect:
```bash
ssh -p 2299 -i C:\Users\DayaTech\.ssh\taranom_server taranom-admin@45.90.98.99
```

Deploy command (run on server):
```bash
cd /home/taranom-admin/crm-taranom && git pull origin claude/claude-md-docs-2ssrpy && cd server && npm install && pm2 restart crm-taranom
```
