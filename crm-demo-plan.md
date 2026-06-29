# CRM ترنم — Demo, Security & Market Plan

## Decision Log
- Demo is standalone HTML (no server required), committed to repo root
- "Impossible grid" = full Pivot Table with drag-and-drop, heatmap, chart toggle — built from scratch in vanilla JS
- Security hardening: add helmet, express-validator, enhanced rate limiting
- Brochure: printable HTML → PDF, Persian language
- Market analysis: based on Iranian CRM/textile sector research

## Phases

### Phase 1 — Demo File [demo.html]
- [ ] Landing/intro screen with auto-demo button
- [ ] Dashboard tab: KPI cards + 3 Chart.js charts
- [ ] Customers tab: searchable table + status badges
- [ ] Advanced Analytics tab: THE PIVOT TABLE (impossible grid)
  - Drag-and-drop field picker (rows / columns / values)
  - Multi-level nested headers
  - Multiple aggregations (sum, count, avg, min, max)
  - Heat map coloring
  - Chart view toggle
  - Export to CSV
  - Grand totals + subtotals
  - Collapsible groups
  - Cell drill-down modal
- [ ] Invoices tab: list + preview panel
- [ ] Products tab: card grid + filters
- [ ] Follow-ups tab: Kanban board with drag-and-drop

### Phase 2 — Security Hardening
- [ ] Add helmet package (security headers, CSP, HSTS)
- [ ] Add express-validator for input sanitization
- [ ] Enhance rate limiting (stricter on auth routes)
- [ ] Add X-Content-Type-Options, X-Frame-Options
- [ ] Sanitize all DB inputs (verify no raw string concat in queries)
- [ ] Add brute-force protection on login endpoint

### Phase 3 — Brochure [brochure.html]
- [ ] Professional A4 layout
- [ ] Feature showcase with icons
- [ ] Pricing tiers
- [ ] Technical specs
- [ ] Screenshots/mockups (CSS-drawn)
- [ ] Contact/CTA section

### Phase 4 — Market Analysis [market-analysis.md]
- [ ] Iranian CRM market overview
- [ ] Textile/clothing sector analysis
- [ ] Competitor pricing research
- [ ] Target customer segments
- [ ] Recommended pricing strategy
- [ ] Revenue projections
- [ ] Distribution channels
