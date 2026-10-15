import electron from "electron";
import type { InferContextLine, SttProvider } from "@aced/shared";
import { APP_NAME } from "@aced/shared";
import {
  type AnswerProviderChoice,
  IpcChannel,
  type AcedApi,
  type NotesQuestion,
  type StatusEntry,
  type UserContext,
} from "./ipc.js";

const { contextBridge, ipcRenderer } = electron;

const api: AcedApi = {
  appName: APP_NAME,
  onLog: (handler) => {
    ipcRenderer.on(IpcChannel.Log, (_event, entry: StatusEntry) => handler(entry));
  },
  close: () => ipcRenderer.send(IpcChannel.Close),
  resetMemory: () => ipcRenderer.send(IpcChannel.ResetMemory),
  config: {
    get: () => ipcRenderer.invoke(IpcChannel.GetConfig),
    setSttProvider: (provider: SttProvider) =>
      ipcRenderer.invoke(IpcChannel.SetSttProvider, provider),
    setAnswerProvider: (provider: AnswerProviderChoice) =>
      ipcRenderer.invoke(IpcChannel.SetAnswerProvider, provider),
  },
  context: {
    get: () => ipcRenderer.invoke(IpcChannel.GetUserContext),
    set: (context: UserContext) => ipcRenderer.invoke(IpcChannel.SetUserContext, context),
  },
  stt: {
    token: (provider: SttProvider) => ipcRenderer.invoke(IpcChannel.SttToken, provider),
    sarvamRelay: () => ipcRenderer.invoke(IpcChannel.SarvamRelay),
  },
  infer: {
    run: (context: InferContextLine[]) => ipcRenderer.invoke(IpcChannel.InferRun, context),
    onDelta: (handler) => {
      ipcRenderer.on(IpcChannel.InferDelta, (_event, text: string) => handler(text));
    },
    onDone: (handler) => {
      ipcRenderer.on(IpcChannel.InferDone, () => handler());
    },
    onError: (handler) => {
      ipcRenderer.on(IpcChannel.InferError, (_event, error: string) => handler(error));
    },
    onHotkey: (handler) => {
      ipcRenderer.on(IpcChannel.InferHotkey, () => handler());
    },
  },
  onLockHotkey: (handler) => {
    ipcRenderer.on(IpcChannel.LockHotkey, () => handler());
  },
  onDimHotkey: (handler) => {
    ipcRenderer.on(IpcChannel.DimHotkey, () => handler());
  },
  dim: {
    sampleBackdrop: () => ipcRenderer.invoke(IpcChannel.BackdropSample),
    setCompact: (compact: boolean) => ipcRenderer.invoke(IpcChannel.SetCompact, compact),
    onWindowMoved: (handler) => {
      ipcRenderer.on(IpcChannel.WindowMoved, () => handler());
    },
    setDelta: (delta: number) => ipcRenderer.invoke(IpcChannel.SetDimDelta, delta),
    onAdjust: (handler) => {
      ipcRenderer.on(IpcChannel.DimAdjust, (_event, step: number) => handler(step));
    },
  },
  coding: {
    run: (context: InferContextLine[]) => ipcRenderer.invoke(IpcChannel.CodingRun, context),
    onHotkey: (handler) => {
      ipcRenderer.on(IpcChannel.CodingHotkey, () => handler());
    },
  },
  pseudocode: {
    run: () => ipcRenderer.invoke(IpcChannel.PseudocodeRun),
    onHotkey: (handler) => {
      ipcRenderer.on(IpcChannel.PseudocodeHotkey, () => handler());
    },
  },
  explain: {
    run: (context: InferContextLine[]) => ipcRenderer.invoke(IpcChannel.ExplainRun, context),
    onHotkey: (handler) => {
      ipcRenderer.on(IpcChannel.ExplainHotkey, () => handler());
    },
  },
  transcript: {
    line: (speaker: "you" | "them", text: string) =>
      ipcRenderer.send(IpcChannel.TranscriptLine, speaker, text),
  },
  notes: {
    open: (questions: NotesQuestion[]) => ipcRenderer.invoke(IpcChannel.NotesOpen, questions),
  },
  keys: {
    get: () => ipcRenderer.invoke(IpcChannel.KeysGet),
    save: (entries) => ipcRenderer.invoke(IpcChannel.KeysSave, entries),
  },
  turn: {
    complete: (utterance: string) => ipcRenderer.invoke(IpcChannel.TurnComplete, utterance),
  },
};

contextBridge.exposeInMainWorld("aced", api);
