/**
 * Fill-agent smoke: drives the REAL fill-sandbox sidecar end-to-end at the
 * library level (no HTTP auth, no chat model) — the deterministic lane the
 * agent's tools orchestrate:
 *
 *   analyze -> fieldmap -> prepare -> fill -> validate -> score gate
 *
 * plus the AcroForm write-back cross-check (read the produced bytes with
 * pdf-lib and prove the values landed in the REAL fields) and the free-form
 * exec lane. Requires the sidecar: npm run sandbox:fill
 *
 *   npm run poc:fill:smoke
 */
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

import { getSandboxClient } from "../../lib/ai/fill-agent/sandbox-client.ts";

const A4: [number, number] = [595.28, 841.89];
const H = A4[1];

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`${ok ? "  ok " : "FAIL "} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures += 1;
}

/** Flat (no AcroForm) German-style form: labels + entry rects + filler text. */
async function digitalSample(): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const page = doc.addPage(A4);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const ink = rgb(0.1, 0.1, 0.12);
  page.drawText("Angebot für die Ausschreibung — bitte alle Felder ausfüllen.", {
    x: 72, y: H - 90, size: 9, font, color: ink,
  });
  page.drawText("Firmenname:", { x: 72, y: H - 114, size: 9, font, color: ink });
  // entry box, top-left space [140, 104, 380, 124]
  page.drawRectangle({
    x: 140, y: H - 124, width: 240, height: 20,
    borderColor: ink, borderWidth: 1,
  });
  page.drawText("Umsatz 2025:", { x: 72, y: H - 150, size: 9, font, color: ink });
  // entry box, top-left space [140, 140, 380, 160]
  page.drawRectangle({
    x: 140, y: H - 160, width: 240, height: 20,
    borderColor: ink, borderWidth: 1,
  });
  return Buffer.from(await doc.save());
}

/** Native AcroForm sample with two real text fields. */
async function acroformSample(): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const page = doc.addPage(A4);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const form = doc.getForm();
  page.drawText("Bewerbungsbogen (AcroForm)", { x: 72, y: H - 90, size: 12, font });
  page.drawText("Firmenname:", { x: 72, y: H - 130, size: 9, font });
  const name = form.createTextField("firmenname");
  name.addToPage(page, { x: 160, y: H - 138, width: 220, height: 18 });
  page.drawText("Ort, Datum:", { x: 72, y: H - 170, size: 9, font });
  const date = form.createTextField("ort_datum");
  date.addToPage(page, { x: 160, y: H - 178, width: 220, height: 18 });
  return Buffer.from(await doc.save());
}

/** Image-only page — must classify as scanned and be refused upstream. */
async function scannedSample(): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const page = doc.addPage(A4);
  page.drawRectangle({ x: 40, y: 40, width: 500, height: 760, color: rgb(0.96, 0.96, 0.94) });
  return Buffer.from(await doc.save());
}

async function main() {
  const sandbox = getSandboxClient();

  const health = await sandbox.health();
  check("sidecar healthy", health.ok === true, `toolkit ${health.toolkitVersion}`);

  // ---------------------------------------------------------- digital lane
  {
    const ws = await sandbox.createSession();
    await sandbox.uploadFile(ws, "source.pdf", await digitalSample());
    const analyze = await sandbox.runAnalyze(ws);
    check("digital classifies as flattened", analyze.kind === "flattened", analyze.kind);
    check("digital finds empty boxes", (analyze.emptyBoxCount ?? 0) >= 2);

    const fieldmap = {
      fields: [
        {
          id: "company_name", page: 1, kind: "text",
          box: [142, 106, 378, 122], value: "Muster Bau GmbH",
          value_type: "text", label: "Firmenname",
        },
        {
          id: "revenue_2025", page: 1, kind: "text",
          box: [142, 142, 378, 158], value: "2450000",
          value_type: "eur", label: "Umsatz 2025",
        },
      ],
    };
    await sandbox.uploadFile(ws, "fieldmap.json", Buffer.from(JSON.stringify(fieldmap)));
    await sandbox.runPrepare(ws);
    await sandbox.runFill(ws);
    const result = await sandbox.runValidate(ws);
    const errors = result.issues.filter((issue) => issue.severity === "error");
    check("digital validate has no errors", errors.length === 0, result.summary.slice(0, 200));
    check("digital score above gate", result.score >= 0.9, String(result.score));

    const prepared = JSON.parse(
      (await sandbox.downloadFile(ws, "fieldmap.prepared.json")).toString("utf-8"),
    ) as { fields: Array<{ id: string; value: string }> };
    const eur = prepared.fields.find((field) => field.id === "revenue_2025")?.value;
    check("German EUR formatting is deterministic", eur === "2.450.000,00", eur);

    const execResult = await sandbox.exec(
      ws,
      "from toolkit import extract\nprint(extract.classify('source.pdf'))",
    );
    check(
      "free-form exec lane works (toolkit importable)",
      execResult.exitCode === 0 && execResult.stdout.includes("flattened"),
      execResult.stderr.slice(0, 120),
    );
    await sandbox.deleteSession(ws);
  }

  // --------------------------------------------------------- acroform lane
  {
    const ws = await sandbox.createSession();
    await sandbox.uploadFile(ws, "source.pdf", await acroformSample());
    const analyze = await sandbox.runAnalyze(ws);
    check("acroform classifies as acroform", analyze.kind === "acroform", analyze.kind);
    check(
      "acroform inventory names the real fields",
      (analyze.nativeFields ?? []).map((field) => field.field_id).sort().join(",") ===
        "firmenname,ort_datum",
    );

    const fieldmap = {
      fields: [
        {
          id: "firmenname", page: 1, kind: "text", target: "acroform",
          box: [160, 120, 380, 138], value: "Muster Bau GmbH", label: "Firmenname",
        },
        {
          id: "ort_datum", page: 1, kind: "text", target: "acroform",
          box: [160, 160, 380, 178], value: "Berlin, 17.07.2026", label: "Ort, Datum",
        },
      ],
    };
    await sandbox.uploadFile(ws, "fieldmap.json", Buffer.from(JSON.stringify(fieldmap)));
    await sandbox.runPrepare(ws);
    await sandbox.runFill(ws);
    const result = await sandbox.runValidate(ws);
    const errors = result.issues.filter((issue) => issue.severity === "error");
    check("acroform validate has no errors", errors.length === 0, result.summary.slice(0, 200));

    // Independent write-back proof with a DIFFERENT reader than the writer:
    // the values must be in the real fields, not painted over them.
    const filled = await sandbox.downloadFile(ws, "filled.pdf");
    const readBack = await PDFDocument.load(filled);
    const form = readBack.getForm();
    check(
      "pdf-lib reads the native values back",
      form.getTextField("firmenname").getText() === "Muster Bau GmbH" &&
        form.getTextField("ort_datum").getText() === "Berlin, 17.07.2026",
    );
    await sandbox.deleteSession(ws);
  }

  // ---------------------------------------------------------- scanned lane
  {
    const ws = await sandbox.createSession();
    await sandbox.uploadFile(ws, "source.pdf", await scannedSample());
    const analyze = await sandbox.runAnalyze(ws);
    check("scanned classifies as scanned (refusal path)", analyze.kind === "scanned", analyze.kind);
    await sandbox.deleteSession(ws);
  }

  console.log(failures === 0 ? "\nSMOKE PASSED" : `\nSMOKE FAILED (${failures})`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error("SMOKE ERRORED:", error);
  process.exit(1);
});
