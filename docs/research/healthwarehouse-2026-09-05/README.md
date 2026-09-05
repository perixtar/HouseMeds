**HealthWarehouse research evidence — September 5, 2026**

This folder contains research observations supporting the HouseMed V1 technical plan. It is not a production medication database or an implemented scraper.

- `page-observations.json`: summarized browser observations for 30 unique rendered pages, including 21 products and 79 structured offers. Price values were read from the public page Product JSON-LD and selected visible UI states. Package-unit interpretations are annotated; they are not substitutes for verified product identifiers.
- `http-observations.json`: three bounded plain HTTP requests returned 403 Cloudflare challenges. The XML sitemap browser attempt was blocked by the client. XML contents were not inspected or counted toward the 30-page review.

The ledger is a structured research summary, not a byte-for-byte HTML archive. Original source-markup fixtures should be captured as part of the proposed parser implementation. Ephemeral challenge bodies and response headers containing unnecessary request metadata were discarded after their status was summarized.

All observed products were marked in stock. No login, checkout, purchase, prescription upload, or household medical-data submission was performed. Prices are dated observations and are not guaranteed current checkout quotes. Broader catalog coverage, unattended collection, and reuse rights were not established by this research.
