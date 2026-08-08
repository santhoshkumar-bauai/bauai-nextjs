# German Procurement Glossary

**All code identifiers are English** — schema names, `docClass` values,
fields, variables. The source documents, however, are German, and the
extraction prompts / classification heuristics match against German
vocabulary. This glossary is the reading aid: what the German terms in real
tender documents mean, and which English identifier they map to.

One distinction to never blur: **suitability criteria** (who may bid,
§ 122 GWB) and **award criteria** (how bids are scored, § 127 GWB) are
legally separate concepts. Keep them in separate schemas, always.

## Extraction schemas (roadmap §18)

| Schema (code) | German term in documents | What it captures |
|---|---|---|
| `deadlines` | Fristen | Submission deadline, question deadline, bid validity (binding) period, award timeline |
| `suitability_criteria` | Eignungskriterien | Who is *allowed* to bid (§ 122 GWB): required experience, references, revenue, staff, certifications |
| `award_criteria` | Zuschlagskriterien | How bids are *scored* (§ 127 GWB): price/quality weighting, evaluation matrix |
| `required_proofs` | Nachweise | The documents a bidder must furnish: certificates, self-declarations, registry extracts, insurance confirmations |
| `contractual_penalties` | Vertragsstrafen | Penalty clauses: delay penalties (% per day/week), caps, liability triggers |
| `payment_terms` | Zahlungsbedingungen | Payment schedule, retention (Sicherheitseinbehalt), discount terms (Skonto), invoicing rules |
| `alternative_bids` | Nebenangebote | Whether variant/alternative proposals are permitted (optional 7th schema) |

## Document classes (`docClass`, roadmap §15.3)

| Value (code) | German term in documents | Notes |
|---|---|---|
| `tender_notice` | Bekanntmachung | The published notice itself |
| `conditions_of_participation` | Bewerbungsbedingungen | How to apply/bid; often contains deadlines + required proofs |
| `contract_conditions` | Vertragsbedingungen | Draft contract; source for penalties + payment terms |
| `bill_of_quantities` | Leistungsverzeichnis ("LV") | The itemized scope of works; basis for pricing |
| `price_sheet` | Preisblatt | Form the bidder fills with prices |
| `suitability_proof_form` | Eignungsnachweis-Formular | Form for declaring suitability facts |
| `award_matrix` | Zuschlagsmatrix | Scoring/weighting table |
| `deadline_schedule` | Fristen-/Terminplan | Milestone and deadline listing |
| `technical_specification` | Technische Spezifikation | Technical requirements |
| `standard_form` | Formblatt | Numbered official forms (e.g. VHB 124) |
| `annex` | Anlage | Generic attachment |

## Legal references you will see in chunks (`legalRefs`)

| Code | What it is |
|---|---|
| `VOB/A`, `VOB/B` | Construction procurement rules: part A = award procedure, part B = contract execution (e.g. § 13 VOB/B = defects liability) |
| `VgV` | Public procurement regulation (above EU thresholds) |
| `GWB` | Competition act; §§ 97 ff. are the procurement backbone |
| `UVgO` | Procurement rules below EU thresholds |
| `HOAI` | Fee structure for architects/engineers |
| `BGB` | Civil code |
| `VwVfG` | Administrative procedure act |

## Recurring document vocabulary

| German | English |
|---|---|
| Angebotsfrist / Abgabefrist | Bid submission deadline |
| Ausschreibung / Vergabe | Tender / award procedure |
| Auftraggeber (AG) | Contracting authority (buyer) |
| Bieter / Bewerber | Bidder / applicant |
| Bindefrist | Bid validity period |
| Deckungssumme | Insurance coverage amount |
| Eigenerklärung | Self-declaration |
| Haftpflichtversicherung | Liability insurance |
| Los / Lose | Lot / lots |
| Nebenangebot | Alternative (variant) bid |
| Referenzen | Reference projects |
| Sicherheitseinbehalt | Retention (security withholding) |
| Skonto | Early-payment discount |
| Vergabeunterlagen | Tender documents (the package) |
| Wertungskriterien | Evaluation criteria |
| Zuschlag | Award (of the contract) |
