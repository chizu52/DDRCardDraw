import {
  DialogBody,
  FormGroup,
  Tabs,
  Tab,
  InputGroup,
  Button,
} from "@blueprintjs/core";
import { ConfigSelect } from ".";
import { PlayerListInput } from "./player-list-input";
import {
  MatchPicker,
  GauntletPicker,
  SheetGauntletPicker,
  PickedMatch,
} from "../matches";
import { StartggApiKeyGated } from "../startgg-gql/components";
import { createDraw } from "../state/thunks";
import { useAppDispatch } from "../state/store";
import { Player, SimpleMeta, newPlayer } from "../models/Drawing";
import { useState } from "react";
import { useAppMode } from "../common-components/app-mode";
import { DrawingMeta } from "../card-draw";
import { useLastConfigSelected } from "../state/config.atoms";

interface Props {
  onClose(): void;
  onDrawAttempt(wasSuccess: boolean): void;
}

export function DrawDialog(props: Props) {
  const [configId, setConfigId] = useState<string | null>(
    useLastConfigSelected() || null,
  );
  const dispatch = useAppDispatch();
  const appMode = useAppMode();

  function handleStartggDraw(match: PickedMatch) {
    return handleDraw({
      type: "startgg",
      subtype: match.subtype,
      players: match.players,
      title: match.title,
      id: match.id,
      // MatchPicker/GauntletPicker always pass a real string (falling
      // back to "" themselves) -- the || "" here is just to satisfy
      // PickedMatch's phaseName being optional (SheetGauntletPicker's
      // picks never set it, since there's no start.gg phase behind them).
      phaseName: match.phaseName || "",
    });
  }

  // Same idea as handleStartggDraw, but for a pool picked from the
  // spreadsheet (SheetGauntletPicker) instead of a start.gg phase --
  // deliberately type: "sheet", not "startgg" (see SheetGauntletMeta's
  // own comment in models/Drawing.ts for why).
  function handleSheetGauntletDraw(match: PickedMatch) {
    return handleDraw({
      type: "sheet",
      subtype: "gauntlet",
      players: match.players,
      title: match.title,
      id: match.id,
    });
  }

  function handleDraw(meta: DrawingMeta["meta"]) {
    if (!configId) {
      return;
    }
    props.onClose();
    void dispatch(createDraw({ meta }, configId)).then((result) => {
      props.onDrawAttempt(result === "ok");
    });
  }

  return (
    <DialogBody>
      <FormGroup label="Config">
        <ConfigSelect selectedId={configId} onChange={setConfigId} />
      </FormGroup>
      <Tabs id="new-draw">
        <Tab
          id="custom"
          panel={
            <CustomDrawForm disableCreate={!configId} onSubmit={handleDraw} />
          }
        >
          custom draw
        </Tab>
        {appMode === "event" && (
          <Tab
            id="startgg-versus"
            panel={
              <StartggApiKeyGated>
                <MatchPicker onPickMatch={handleStartggDraw} />
              </StartggApiKeyGated>
            }
          >
            start.gg (h2h)
          </Tab>
        )}
        {appMode === "event" && (
          <Tab
            id="startgg-group"
            panel={
              <StartggApiKeyGated>
                <GauntletPicker onPickMatch={handleStartggDraw} />
              </StartggApiKeyGated>
            }
          >
            start.gg (gauntlet)
          </Tab>
        )}
        {appMode === "event" && (
          <Tab
            id="sheet-group"
            panel={
              <SheetGauntletPicker onPickMatch={handleSheetGauntletDraw} />
            }
          >
            spreadsheet (gauntlet)
          </Tab>
        )}
      </Tabs>
    </DialogBody>
  );
}

export function CustomDrawForm(props: {
  initialMeta?: SimpleMeta;
  disableCreate?: boolean;
  submitText?: string;
  onSubmit(meta: SimpleMeta): void;
}) {
  // meta.players is already in display order
  const [players, setPlayers] = useState<Player[]>(
    () => props.initialMeta?.players ?? [newPlayer("P1"), newPlayer("P2")],
  );
  const [title, setTitle] = useState<string>(props.initialMeta?.title || "");

  function handleSubmit() {
    props.onSubmit({
      type: "simple",
      players,
      title,
    });
  }
  return (
    <>
      <FormGroup label="title">
        <InputGroup
          value={title}
          onChange={(e) => setTitle(e.currentTarget.value)}
        />
      </FormGroup>
      <FormGroup label="players">
        <PlayerListInput value={players} onChange={setPlayers} />
      </FormGroup>
      <Button
        intent="primary"
        onClick={handleSubmit}
        disabled={props.disableCreate}
      >
        {props.submitText || "Create"}
      </Button>
    </>
  );
}
