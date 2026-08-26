/**
 * Server-side, locale-resolved strings for block CHROME — titles, row labels,
 * empty states.
 *
 * Deliberately not next-intl keys. A block's payload is content, not layout:
 * it is assembled server-side from the collections and travels over the wire
 * as finished text, the same way Clara's answers do. Sending "GenUi.blocks.
 * deadlines.title" instead would mean the client owns half of every block and
 * a new block could not be added without touching two catalogs.
 *
 * The MODEL never writes these. It picks blocks and arguments; the labels here
 * are fixed, translated once, and identical for every company.
 */

export type IrisLocale = "en" | "de";

type Entry = Record<IrisLocale, string>;

const STRINGS = {
  // Blocks
  metricsTitle: { en: "Portfolio at a glance", de: "Portfolio auf einen Blick" },
  metricsCaption: {
    en: "Live from your matched feed and your board.",
    de: "Live aus deinem Match-Feed und deinem Board.",
  },
  metricMatched: { en: "Matched", de: "Passend" },
  metricClosingWeek: { en: "Closing in 7 days", de: "Frist in 7 Tagen" },
  metricOnBoard: { en: "On the board", de: "Auf dem Board" },
  metricSubmitted: { en: "Submitted", de: "Abgegeben" },
  metricAvgMatch: { en: "Average match", de: "Durchschnitts-Match" },

  feedTitle: { en: "Matched opportunities", de: "Passende Ausschreibungen" },
  feedEmpty: {
    en: "Nothing matches those filters. Widen the region, the sector or the deadline window.",
    de: "Keine Treffer für diese Filter. Erweitere Region, Gewerk oder Fristfenster.",
  },

  compareTitle: { en: "Side by side", de: "Direktvergleich" },
  rowDeadline: { en: "Deadline", de: "Frist" },
  rowDaysLeft: { en: "Days left", de: "Tage übrig" },
  rowBuyer: { en: "Buyer", de: "Auftraggeber" },
  rowValue: { en: "Estimated value", de: "Geschätzter Wert" },
  rowProcedure: { en: "Procedure", de: "Verfahren" },
  rowNature: { en: "Contract type", de: "Auftragsart" },
  rowRegion: { en: "Region", de: "Region" },
  rowBoard: { en: "Board status", de: "Board-Status" },
  rowDecision: { en: "Stored decision", de: "Gespeicherte Entscheidung" },
  rowDocuments: { en: "Documents fetched", de: "Geladene Dokumente" },

  verdictTitle: { en: "Bid decision", de: "Bid-Entscheidung" },
  verdictMissing: {
    en: "No verdict has been generated for this tender yet. Open the tender's report page to produce one.",
    de: "Für diese Ausschreibung wurde noch kein Verdict erzeugt. Erzeuge es auf der Report-Seite der Ausschreibung.",
  },
  scoreEligibility: { en: "Eligibility fit", de: "Eignung" },
  scoreStrategic: { en: "Strategic fit", de: "Strategischer Fit" },
  scoreCapacity: { en: "Capacity fit", de: "Kapazität" },
  scoreContractRisk: { en: "Contract risk", de: "Vertragsrisiko" },
  scoreDeadline: { en: "Deadline feasibility", de: "Fristmachbarkeit" },

  requirementsTitle: { en: "Requirements", de: "Anforderungen" },
  requirementsFromReport: {
    en: "Assessed against your company profile and documents.",
    de: "Bewertet gegen dein Firmenprofil und deine Dokumente.",
  },
  requirementsFromExtraction: {
    en: "Extracted from the tender documents. Not yet assessed against your company — generate the report for that.",
    de: "Aus den Vergabeunterlagen extrahiert. Noch nicht gegen dein Unternehmen bewertet — erzeuge dafür den Report.",
  },
  requirementsMissing: {
    en: "No suitability criteria have been extracted for this tender yet.",
    de: "Für diese Ausschreibung wurden noch keine Eignungskriterien extrahiert.",
  },

  timelineTitle: { en: "Timeline", de: "Zeitplan" },
  timelineMissing: {
    en: "No dates beyond the notice are known for this tender yet.",
    de: "Außer der Bekanntmachung sind noch keine Termine bekannt.",
  },
  timelinePublication: { en: "Published", de: "Veröffentlicht" },
  timelineSubmission: { en: "Submission deadline", de: "Angebotsfrist" },

  tenderDocumentsTitle: { en: "Tender documents", de: "Vergabeunterlagen" },
  companyDocumentsTitle: { en: "Company documents", de: "Firmendokumente" },
  documentsMissing: {
    en: "No document files have been downloaded for this tender yet.",
    de: "Für diese Ausschreibung wurden noch keine Dateien geladen.",
  },
  companyDocumentsMissing: {
    en: "No company documents have been uploaded yet.",
    de: "Es wurden noch keine Firmendokumente hochgeladen.",
  },

  evidenceTitle: { en: "Evidence", de: "Belege" },
  evidenceMissing: {
    en: "Nothing in the indexed documents matches that query.",
    de: "In den indizierten Dokumenten gibt es dazu keine Treffer.",
  },

  boardTitle: { en: "Your bid pipeline", de: "Deine Bid-Pipeline" },
  boardEmpty: {
    en: "No tenders on the board yet.",
    de: "Noch keine Ausschreibungen auf dem Board.",
  },

  cpvTitle: { en: "CPV codes", de: "CPV-Codes" },
  cpvMissing: {
    en: "No CPV codes match that.",
    de: "Dazu passen keine CPV-Codes.",
  },

  filtersTitle: { en: "Refine the feed", de: "Feed verfeinern" },
  filtersCaption: {
    en: "Facets are built from what is actually in your current results.",
    de: "Die Facetten stammen aus deinen aktuellen Treffern.",
  },
  filtersApply: { en: "Apply filters", de: "Filter anwenden" },
  facetSector: { en: "Sector", de: "Gewerk" },
  facetRegion: { en: "Region", de: "Region" },
  facetNature: { en: "Contract type", de: "Auftragsart" },

  tenderNotFound: {
    en: "That tender could not be found or is not visible.",
    de: "Diese Ausschreibung wurde nicht gefunden oder ist nicht sichtbar.",
  },
  renderFailed: {
    en: "This view could not be assembled.",
    de: "Diese Ansicht konnte nicht erstellt werden.",
  },
  unknown: { en: "Unknown", de: "Unbekannt" },
  none: { en: "—", de: "—" },
} satisfies Record<string, Entry>;

export type IrisStringKey = keyof typeof STRINGS;

export function t(locale: IrisLocale, key: IrisStringKey): string {
  return STRINGS[key][locale];
}
