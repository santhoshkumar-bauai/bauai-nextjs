---
name: adaptive-pdf-filling
description: Inspect unknown PDFs, create one grounded whole-document fill plan, fill deterministically, verify placement against printed labels, and repair only failed regions from the page plus 400-DPI crops. Use for AcroForms, flattened PDFs, scanned/OCR forms, hybrids, and mixed-page documents.
---

# Adaptive PDF Filling

Use this skill when a PDF's structure is not known in advance.

## Invariants

1. Inspect before mapping. Classify every page as AcroForm, digital/flattened,
   scanned/OCR, hybrid, XFA, or unsupported/damaged. A single PDF may mix
   strategies.
2. Plan the initial fill once for the complete document. The model may use all
   source-page renders and document geometry, but it selects stable `anchorId`
   values only. Trusted code owns coordinates and writes the PDF.
3. Enumerate native form field IDs, pages, types, options, inherited values,
   widget appearances, duplicates, and orphan widgets before writing. Preserve
   form interactivity unless flattening was explicitly requested.
4. For flattened or scanned pages, extract deterministic anchors for boxes,
   table cells, leader lines, standalone dash placeholders, and checkbox/radio
   glyphs. OCR scanned pages at 300 DPI with `deu+eng` when available.
5. Ground each value in user input or company evidence. Model inference alone
   is never authorization. Ja/Nein declarations require explicit human
   confirmation, exactly one option may be selected, and signatures are never
   filled automatically.
6. Fill the complete PDF deterministically from the immutable source and the
   canonical field map, then validate the complete rendered result. Follow the
   geometric validation with a visual placement check: every deterministic check
   measures the produced ink against the box the snapper wrote, so a value
   snapped onto the wrong entry is self-consistent and scores clean. Check each
   value against the label it is printed beside; that check may only ADD issues.
7. Batch only post-fill layout repair. Group pages with validation failures
   into ranges of at most four pages. Crop the region the ISSUE names — ordering
   crops by anything else hands the model one region and asks it to fix another.
   For each issue send the filled page (placement), a 400-DPI before/after crop
   of where the value landed (damage), and, when the field's printed label is
   somewhere else on the page, a 400-DPI strip of that destination — a value on
   the wrong row sits inside a real entry box and looks correct in its own crop.
   Reject arbitrary coordinates and changes outside the page; a repair may
   re-select any anchor on the page it is repairing.
8. Limit a region to three repair attempts. Freeze clean repair batches,
   continue independent batches, then rebuild the complete PDF once from the
   immutable source and canonical field map and run final full validation.
9. Stream structured progress events into the chat: action, page scope, model
   tier, crop, anchor, patch summary, score, elapsed time, and remaining issues.
   Never expose hidden reasoning, raw prompts, or chain-of-thought.

## Useful form techniques

- Check fillability and field structure before drawing annotations.
- Validate native field IDs and allowed values before calling a form writer.
- Set `NeedAppearances` and preserve/update appearance streams so values render
  in common viewers.
- Convert image pixels to PDF points only in deterministic code, accounting for
  crop boxes and rotation.
- Compare source and filled renders, not extracted text alone; run bounding-box,
  overlap, clipping, overflow, and missing-render checks.

This skill adapts the useful inspection, field inventory, coordinate conversion,
rendering, and validation practices from the Claude PDF skill case while adding
the repository's anchor-only trust boundary and localized repair workflow.
