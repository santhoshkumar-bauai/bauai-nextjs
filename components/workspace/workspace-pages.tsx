import Link from "next/link";
import { ArrowLeft, Construction } from "lucide-react";

import { KanbanBoardClient, type KanbanColumn } from "./kanban-columns";
import styles from "./workspace-pages.module.css";

type KanbanBoardProps = {
  title: string;
  workspaceLabel: string;
  deadZoneLabel: string;
  noTenders: string;
  emptyHint: string;
  columns: KanbanColumn[];
};

export function KanbanBoard(props: KanbanBoardProps) {
  return <KanbanBoardClient {...props} />;
}

export type { KanbanColumn };

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
