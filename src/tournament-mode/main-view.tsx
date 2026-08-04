import { Section, SectionCard, Tabs, Tab } from "@blueprintjs/core";
import { PlayerNamesControls } from "../controls/player-names";
import { DrawingList } from "../drawing-list";
import { atom, useAtom, useAtomValue } from "jotai";
import styles from "./main-view.css";
import { lazy, Suspense } from "react";
import { ErrorBoundary } from "react-error-boundary";
import { ErrorFallback } from "../utils/error-fallback";
import { DelayedSpinner } from "../common-components/delayed-spinner";
import { SheetsCredsManager } from "../sheets/sheets-creds-manager";
import { sheetsTokenAtom, spreadsheetIdAtom } from "../sheets/sheets-export";
export type MainTabId = "drawings" | "players" | "sets" | "sheets";
export const mainTabAtom = atom<MainTabId>("drawings");
const EligibleChartsList = lazy(() => import("../eligible-charts"));
export function MainView() {
  const [currentTab, setCurrentTab] = useAtom(mainTabAtom);
  // Same "already configured" check as SheetsExportGated (sheets-creds-
  // manager.tsx) -- matches the start.gg panel below, which collapses by
  // default once its own credentials are already saved and stays open
  // otherwise, instead of always reopening on every refresh regardless
  // of connection state.
  const sheetsToken = useAtomValue(sheetsTokenAtom);
  const spreadsheetId = useAtomValue(spreadsheetIdAtom);
  return (
    <Tabs
      id="main-view"
      className={styles.mainView}
      large
      selectedTabId={currentTab}
      onChange={(newTabId: MainTabId) => setCurrentTab(newTabId)}
    >
      <Tab id="drawings" panel={<DrawingList />}>
        Drawings
      </Tab>
      <Tab
        id="eligible"
        panel={
          <ErrorBoundary fallback={<ErrorFallback />}>
            <Suspense fallback={<DelayedSpinner />}>
              <EligibleChartsList />
            </Suspense>
          </ErrorBoundary>
        }
      >
        Eligible Charts
      </Tab>
      <Tab id="players" panel={<PlayerNamesControls />}>
        Start.gg Sync
      </Tab>
      <Tab
        id="sheets"
        panel={
          <Section
            title="Google Spreadsheet Credentials"
            collapsible
            collapseProps={{
              defaultIsOpen: !sheetsToken || !spreadsheetId,
            }}
            style={{ maxWidth: "50em" }}
          >
            <SectionCard>
              <SheetsCredsManager />
            </SectionCard>
          </Section>
        }
      >
        Google Spreadsheet Sync
      </Tab>
    </Tabs>
  );
}
