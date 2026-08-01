import { Button, ButtonGroup, FormGroup, InputGroup } from "@blueprintjs/core";
import { useAtom, useAtomValue } from "jotai";
import React, { ReactNode, useRef, useCallback } from "react";
import {
  sheetsTokenAtom,
  spreadsheetIdAtom,
  googleClientIdAtom,
  sheetsApiKeyAtom,
  requestSheetsToken,
} from "./sheets-export";

export function SheetsExportGated(props: { children: ReactNode }) {
  const token = useAtomValue(sheetsTokenAtom);
  const spreadsheetId = useAtomValue(spreadsheetIdAtom);
  if (token && spreadsheetId) {
    return props.children;
  } else {
    return <SheetsCredsManager />;
  }
}

export function SheetsCredsManager() {
  const [token, setToken] = useAtom(sheetsTokenAtom);
  const [spreadsheetId, setSpreadsheetId] = useAtom(spreadsheetIdAtom);
  const [clientId, setClientId] = useAtom(googleClientIdAtom);
  const [apiKey, setApiKey] = useAtom(sheetsApiKeyAtom);
  const clientIdRef = useRef<HTMLInputElement>(null);
  const sheetIdRef = useRef<HTMLInputElement>(null);
  const apiKeyRef = useRef<HTMLInputElement>(null);

  const saveClientId = useCallback(
    (e: React.FormEvent<HTMLFormElement>) => {
      e.preventDefault();
      if (!clientIdRef.current) return;
      setClientId(clientIdRef.current.value);
    },
    [setClientId],
  );

  const saveSheetId = useCallback(
    (e: React.FormEvent<HTMLFormElement>) => {
      e.preventDefault();
      if (!sheetIdRef.current) return;
      setSpreadsheetId(sheetIdRef.current.value);
    },
    [setSpreadsheetId],
  );

  const saveApiKey = useCallback(
    (e: React.FormEvent<HTMLFormElement>) => {
      e.preventDefault();
      if (!apiKeyRef.current) return;
      setApiKey(apiKeyRef.current.value);
    },
    [setApiKey],
  );

  const connectGoogle = useCallback(() => {
    if (!clientId) return;
    requestSheetsToken(clientId, (newToken) => {
      setToken(newToken);
    });
  }, [clientId, setToken]);

  const consoleLink = "https://console.cloud.google.com/apis/credentials";

  return (
    <>
      <p>
        Google Sheets access is saved locally on this device and never synced
        with other devices
      </p>
      <form onSubmit={saveClientId}>
        <FormGroup
          label={
            <>
              {"Google OAuth client ID ("}
              <a href={consoleLink} target="_blank" rel="noreferrer">
                create one here
              </a>
              {")"}
            </>
          }
        >
          <InputGroup
            defaultValue={clientId || undefined}
            inputRef={clientIdRef}
            rightElement={
              <ButtonGroup>
                <Button type="submit">Save</Button>
                <Button
                  disabled={!clientId}
                  onClick={connectGoogle}
                  intent={token ? "success" : "primary"}
                >
                  {token ? "Connected — reconnect" : "Connect Google Sheets"}
                </Button>
              </ButtonGroup>
            }
          />
        </FormGroup>
      </form>
      <form onSubmit={saveSheetId}>
        <FormGroup
          label={
            <>
              spreadsheet ID (from the sheet's URL, the part between{" "}
              <pre style={{ display: "inline" }}>/d/</pre> and{" "}
              <pre style={{ display: "inline" }}>/edit</pre>)
            </>
          }
        >
          <InputGroup
            disabled={!token}
            defaultValue={spreadsheetId || undefined}
            inputRef={sheetIdRef}
            rightElement={<Button type="submit">Save</Button>}
          />
        </FormGroup>
      </form>
      <form onSubmit={saveApiKey}>
        <FormGroup
          label={
            <>
              {"Sheets read-only API key, optional ("}
              <a href={consoleLink} target="_blank" rel="noreferrer">
                create one here
              </a>
              {", restricted to just the Sheets API) -- only used by the "}
              <strong>pool-results OBS overlay</strong>
              {", so it can show live results without needing the "}
              {"Google-account popup above (which can't run inside OBS). "}
              {"Only works against a spreadsheet shared as "}
              <em>Anyone with the link can view</em>
              {"."}
            </>
          }
        >
          <InputGroup
            defaultValue={apiKey || undefined}
            inputRef={apiKeyRef}
            rightElement={<Button type="submit">Save</Button>}
          />
        </FormGroup>
      </form>
    </>
  );
}
