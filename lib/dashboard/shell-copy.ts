import { getTranslations } from "next-intl/server";

/**
 * Builds the DashboardShell copy object from the Dashboard translation
 * namespace. Shared by the workspace section page and the settings layout so the
 * sidebar/profile-menu strings stay consistent.
 */
export async function buildDashboardCopy() {
  const dashboard = await getTranslations("Dashboard");
  return {
    greeting: dashboard("goodMorning"),
    chooseAgent: dashboard("chooseAgent"),
    comingSoon: dashboard("comingSoon"),
    composerPlaceholder: dashboard("composerPlaceholder"),
    attachDocument: dashboard("attachDocument"),
    send: dashboard("send"),
    profileMenu: {
      open: dashboard("profileMenu.open"),
      profileSettings: dashboard("profileMenu.profileSettings"),
      language: dashboard("profileMenu.language"),
      english: dashboard("profileMenu.english"),
      german: dashboard("profileMenu.german"),
      signOut: dashboard("profileMenu.signOut"),
      signingOut: dashboard("profileMenu.signingOut"),
    },
    nav: {
      aiBoard: dashboard("nav.aiBoard"),
      workspace: dashboard("nav.workspace"),
      tenders: dashboard("nav.tenders"),
      documentFiller: dashboard("nav.documentFiller"),
      beta: dashboard("nav.beta"),
      tutorial: dashboard("nav.tutorial"),
      settings: dashboard("nav.settings"),
      notifications: dashboard("nav.notifications"),
      pricing: dashboard("nav.pricing"),
      support: dashboard("nav.support"),
      collapse: dashboard("nav.collapse"),
      expand: dashboard("nav.expand"),
    },
    agents: [],
  };
}
