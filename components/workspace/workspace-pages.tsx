import Link from "next/link";
import {
  ArrowLeft,
  Construction,
  Inbox,
  RefreshCw,
  UserPlus,
  UsersRound,
} from "lucide-react";
import type { CSSProperties } from "react";

import styles from "./workspace-pages.module.css";

type KanbanColumn = {
  key: string;
  title: string;
  color: string;
  tint: string;
};

type KanbanBoardProps = {
  title: string;
  tenderCount: string;
  previewTitle: string;
  previewDescription: string;
  workspaceLabel: string;
  deadZoneLabel: string;
  noTenders: string;
  emptyHint: string;
  columns: KanbanColumn[];
};

export function KanbanBoard({
  title,
  tenderCount,
  previewTitle,
  previewDescription,
  workspaceLabel,
  deadZoneLabel,
  noTenders,
  emptyHint,
  columns,
}: KanbanBoardProps) {
  return (
    <div className={styles.kanbanPage}>
      <header className={styles.kanbanHeader}>
        <div className={styles.pipelineTitle}>
          <ArrowLeft size={15} />
          <strong>{title}</strong>
          <span>{tenderCount}</span>
        </div>
        <div className={styles.headerActions} aria-hidden="true">
          <button type="button" className={styles.roundAction}>
            <UsersRound size={16} />
          </button>
          <button type="button" className={styles.roundAction}>
            <UserPlus size={16} />
          </button>
          <div className={styles.viewSwitch}>
            <span className={styles.activeView}>{workspaceLabel}</span>
            <span>{deadZoneLabel}</span>
          </div>
          <RefreshCw size={15} />
        </div>
      </header>

      <div className={styles.buildNotice}>
        <Construction size={18} />
        <div>
          <strong>{previewTitle}</strong>
          <span>{previewDescription}</span>
        </div>
      </div>

      <div className={styles.boardScroller}>
        <div className={styles.board}>
          {columns.map((column) => (
            <section
              key={column.key}
              className={styles.column}
              style={
                {
                  "--column-color": column.color,
                  "--column-tint": column.tint,
                } as CSSProperties
              }
            >
              <header className={styles.columnHeader}>
                <strong>{column.title}</strong>
                <span>0</span>
              </header>
              <div className={styles.columnBody}>
                <div className={styles.emptyState}>
                  <span className={styles.emptyIcon}>
                    <Inbox size={18} />
                  </span>
                  <strong>{noTenders}</strong>
                  <p>{emptyHint}</p>
                </div>
              </div>
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}

type ComingSoonPageProps = {
  section: string;
  eyebrow: string;
  title: string;
  description: string;
  backLabel: string;
};

export function ComingSoonPage({
  section,
  eyebrow,
  title,
  description,
  backLabel,
}: ComingSoonPageProps) {
  return (
    <div className={styles.comingSoonPage}>
      <div className={styles.comingSoonGrid} aria-hidden="true" />
      <div className={styles.comingSoonGlow} aria-hidden="true" />
      <section className={styles.comingSoonCard}>
        <span className={styles.constructionIcon}>
          <Construction size={27} />
        </span>
        <small>{eyebrow}</small>
        <h1>{section}</h1>
        <h2>{title}</h2>
        <p>{description}</p>
        <Link href="/dashboard">
          <ArrowLeft size={16} />
          {backLabel}
        </Link>
      </section>
    </div>
  );
}
