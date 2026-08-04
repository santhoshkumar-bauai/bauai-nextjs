"use client";

import Image from "next/image";
import Link from "next/link";
import {
  ArrowUp,
  Bell,
  BriefcaseBusiness,
  ChevronLeft,
  ChevronRight,
  CreditCard,
  FileSearch,
  FileText,
  Headphones,
  LayoutGrid,
  Languages,
  LogOut,
  Paperclip,
  Settings,
  Sparkles,
  UserRound,
} from "lucide-react";
import { useLocale } from "next-intl";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState, type ReactNode } from "react";

import { localeCookie, type Locale } from "@/i18n/config";
import { authClient } from "@/lib/auth-client";

import styles from "./dashboard.module.css";

type Agent = {
  name: string;
  role: string;
  description: string;
  image: string;
  available: boolean;
  remaining?: string;
};

type DashboardCopy = {
  nav: {
    aiBoard: string;
    workspace: string;
    tenders: string;
    documentFiller: string;
    beta: string;
    tutorial: string;
    settings: string;
    notifications: string;
    pricing: string;
    support: string;
    collapse: string;
    expand: string;
  };
  greeting: string;
  chooseAgent: string;
  comingSoon: string;
  composerPlaceholder: string;
  attachDocument: string;
  send: string;
  profileMenu: {
    open: string;
    profileSettings: string;
    language: string;
    english: string;
    german: string;
    signOut: string;
    signingOut: string;
  };
  agents: Agent[];
};

type DashboardShellProps = {
  copy: DashboardCopy;
  dateLabel: string;
  firstName: string;
  fullName: string;
  email: string;
  adminPanel?: ReactNode;
  workspaceContent?: ReactNode;
};

const mainNavigation = [
  { key: "aiBoard" as const, icon: LayoutGrid, href: "/dashboard" },
  { key: "workspace" as const, icon: BriefcaseBusiness, href: "/kanban" },
  { key: "tenders" as const, icon: FileSearch, href: "/tenders" },
  {
    key: "documentFiller" as const,
    icon: FileText,
    href: "/document-filler",
    beta: true,
  },
];

const secondaryNavigation = [
  { key: "tutorial" as const, icon: Sparkles, href: "/tutorial" },
  { key: "settings" as const, icon: Settings, href: "/settings" },
  { key: "notifications" as const, icon: Bell, href: "/notifications" },
  { key: "pricing" as const, icon: CreditCard, href: "/pricing" },
  { key: "support" as const, icon: Headphones, href: "/support" },
];

export function DashboardShell({
  copy,
  dateLabel,
  firstName,
  fullName,
  email,
  adminPanel,
  workspaceContent,
}: DashboardShellProps) {
  const [collapsed, setCollapsed] = useState(false);
  const [selectedAgent, setSelectedAgent] = useState("Clara");
  const [fileName, setFileName] = useState("");
  const [profileMenuOpen, setProfileMenuOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const profileMenuRef = useRef<HTMLDivElement>(null);
  const locale = useLocale();
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    if (!profileMenuOpen) return;
    const closeMenu = (event: MouseEvent) => {
      if (!profileMenuRef.current?.contains(event.target as Node))
        setProfileMenuOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setProfileMenuOpen(false);
    };
    document.addEventListener("mousedown", closeMenu);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("mousedown", closeMenu);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [profileMenuOpen]);

  const changeLocale = (nextLocale: Locale) => {
    document.cookie = `${localeCookie}=${nextLocale};path=/;max-age=31536000;samesite=lax`;
    setProfileMenuOpen(false);
    router.refresh();
  };

  const handleSignOut = async () => {
    if (signingOut) return;
    setSigningOut(true);
    const result = await authClient.signOut();
    if (result.error) {
      setSigningOut(false);
      return;
    }
    router.replace("/login");
    router.refresh();
  };

  return (
    <main className={`${styles.shell} ${collapsed ? styles.isCollapsed : ""}`}>
      <aside className={styles.sidebar} aria-label="BAU AI">
        <div className={styles.brandRow}>
          <Link
            href="/dashboard"
            className={styles.brandLink}
            aria-label="BAU AI dashboard"
          >
            <Image
              src={collapsed ? "/brand/logo_small.svg" : "/brand/logo_name.svg"}
              width={collapsed ? 36 : 112}
              height={36}
              alt="BAU AI"
              priority
            />
          </Link>
          <button
            type="button"
            className={styles.collapseButton}
            onClick={() => setCollapsed((value) => !value)}
            aria-label={collapsed ? copy.nav.expand : copy.nav.collapse}
            title={collapsed ? copy.nav.expand : copy.nav.collapse}
          >
            {collapsed ? <ChevronRight size={16} /> : <ChevronLeft size={16} />}
          </button>
        </div>

        <nav className={styles.navigation} aria-label="Primary navigation">
          <div className={styles.navGroup}>
            {mainNavigation.map((item) => {
              const Icon = item.icon;
              const content = (
                <>
                  <Icon size={19} strokeWidth={1.7} />
                  <span className={styles.navLabel}>{copy.nav[item.key]}</span>
                  {item.beta && (
                    <small className={styles.betaBadge}>{copy.nav.beta}</small>
                  )}
                </>
              );
              return (
                <Link
                  key={item.key}
                  href={item.href}
                  className={`${styles.navItem} ${pathname === item.href ? styles.activeNavItem : ""}`}
                >
                  {content}
                </Link>
              );
            })}
          </div>

          <div className={`${styles.navGroup} ${styles.secondaryNav}`}>
            {secondaryNavigation.map((item) => {
              const Icon = item.icon;
              return (
                <Link
                  key={item.key}
                  href={item.href}
                  className={`${styles.navItem} ${pathname === item.href ? styles.activeNavItem : ""}`}
                >
                  <Icon size={19} strokeWidth={1.7} />
                  <span className={styles.navLabel}>{copy.nav[item.key]}</span>
                </Link>
              );
            })}
          </div>
        </nav>

        <div className={styles.profileArea} ref={profileMenuRef}>
          {profileMenuOpen && (
            <div
              className={styles.profileMenu}
              role="menu"
              aria-label={copy.profileMenu.open}
            >
              <div className={styles.menuIdentity}>
                <div className={styles.avatar}>
                  {fullName.trim().charAt(0).toUpperCase() || "U"}
                </div>
                <div className={styles.profileText}>
                  <strong>{fullName}</strong>
                  <span>{email}</span>
                </div>
              </div>

              <div className={styles.menuSection}>
                <Link
                  href="/profile"
                  className={styles.menuAction}
                  role="menuitem"
                  onClick={() => setProfileMenuOpen(false)}
                >
                  <UserRound size={17} />
                  <span>{copy.profileMenu.profileSettings}</span>
                </Link>
              </div>

              <div className={styles.menuSection}>
                <div className={styles.languageLabel}>
                  <Languages size={17} />
                  <span>{copy.profileMenu.language}</span>
                </div>
                <div
                  className={styles.languageOptions}
                  aria-label={copy.profileMenu.language}
                >
                  <button
                    type="button"
                    className={locale === "en" ? styles.activeLanguage : ""}
                    onClick={() => changeLocale("en")}
                  >
                    {copy.profileMenu.english}
                  </button>
                  <button
                    type="button"
                    className={locale === "de" ? styles.activeLanguage : ""}
                    onClick={() => changeLocale("de")}
                  >
                    {copy.profileMenu.german}
                  </button>
                </div>
              </div>

              <div className={styles.menuSection}>
                <button
                  type="button"
                  className={`${styles.menuAction} ${styles.signOutAction}`}
                  onClick={handleSignOut}
                  disabled={signingOut}
                  role="menuitem"
                >
                  <LogOut size={17} />
                  <span>
                    {signingOut
                      ? copy.profileMenu.signingOut
                      : copy.profileMenu.signOut}
                  </span>
                </button>
              </div>
            </div>
          )}

          <button
            type="button"
            className={styles.profile}
            onClick={() => setProfileMenuOpen((value) => !value)}
            aria-haspopup="menu"
            aria-expanded={profileMenuOpen}
            aria-label={copy.profileMenu.open}
          >
            <div className={styles.avatar}>
              {fullName.trim().charAt(0).toUpperCase() || "U"}
            </div>
            <div className={styles.profileText}>
              <strong>{fullName}</strong>
              <span>{email}</span>
            </div>
          </button>
        </div>
      </aside>

      <section className={styles.workspace}>
        {!workspaceContent && (
          <div className={styles.ambientGlow} aria-hidden="true" />
        )}
        {!workspaceContent && (
          <div className={styles.dotGrid} aria-hidden="true" />
        )}

        {workspaceContent ? (
          <div className={styles.routedContent}>{workspaceContent}</div>
        ) : (
          <div className={styles.content}>
            <header className={styles.hero}>
              <time className={styles.dateBadge}>{dateLabel}</time>
              <h1>
                {copy.greeting}, <span>{firstName}</span>
              </h1>
              <p>{copy.chooseAgent}</p>
            </header>

            <div className={styles.agentGrid}>
              {copy.agents.map((agent) => (
                <button
                  type="button"
                  key={agent.name}
                  className={`${styles.agentCard} ${agent.available ? styles.availableAgent : styles.disabledAgent} ${selectedAgent === agent.name ? styles.selectedAgent : ""}`}
                  onClick={() =>
                    agent.available && setSelectedAgent(agent.name)
                  }
                  disabled={!agent.available}
                  aria-pressed={
                    agent.available ? selectedAgent === agent.name : undefined
                  }
                >
                  <div className={styles.agentTopRow}>
                    <span className={styles.agentAvatar}>
                      <Image
                        src={agent.image}
                        alt=""
                        width={46}
                        height={46}
                        unoptimized
                      />
                    </span>
                    {agent.available ? (
                      <span
                        className={styles.onlineDot}
                        aria-label="Available"
                      />
                    ) : (
                      <span className={styles.comingSoon}>
                        {copy.comingSoon}
                      </span>
                    )}
                  </div>
                  <strong>{agent.name}</strong>
                  <span className={styles.agentRole}>{agent.role}</span>
                  <p>{agent.description}</p>
                  {agent.remaining && (
                    <small className={styles.remainingBadge}>
                      {agent.remaining}
                    </small>
                  )}
                </button>
              ))}
            </div>

            {adminPanel && (
              <div className={styles.adminPanel}>{adminPanel}</div>
            )}

            <div className={styles.workspaceSpacer} />

            <form
              className={styles.composer}
              onSubmit={(event) => event.preventDefault()}
            >
              <input
                ref={fileInputRef}
                type="file"
                className={styles.visuallyHidden}
                accept=".pdf,.doc,.docx,.xls,.xlsx"
                onChange={(event) =>
                  setFileName(event.target.files?.[0]?.name || "")
                }
              />
              <button
                type="button"
                className={styles.composerIcon}
                onClick={() => fileInputRef.current?.click()}
                aria-label={copy.attachDocument}
                title={copy.attachDocument}
              >
                <Paperclip size={18} />
              </button>
              <span
                className={
                  fileName ? styles.fileName : styles.composerPlaceholder
                }
              >
                {fileName || copy.composerPlaceholder}
              </span>
              <button
                type="submit"
                className={styles.sendButton}
                aria-label={copy.send}
                title={copy.send}
              >
                <ArrowUp size={18} />
              </button>
            </form>
          </div>
        )}
      </section>
    </main>
  );
}
