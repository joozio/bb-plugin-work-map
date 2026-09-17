import { useRef, useState } from "react";
import {
  experimental_NewThreadComposer as NewThreadComposer,
  ThreadChat,
  useRpc,
  experimental_useSidebarThreadActions,
} from "@get-bb/plugin-sdk/app";
import type { NewThreadRequest } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./server";
import { sessionResultSchema, type SessionResult } from "./session-contract";
import { Button } from "./components/ui/button";

export type SessionContext = {
  id: string;
  title: string;
  projectId?: string;
  taskId?: string;
  prompt?: string;
};
export function useSessionLauncher(onCreated: () => void) {
  const rpc = useRpc<typeof rpcContract>();
  const actions = experimental_useSidebarThreadActions();
  const [context, setContext] = useState<SessionContext | null>(null);
  const [result, setResult] = useState<SessionResult | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const requestId = useRef("");
  const localRequests = useRef(new Map<string, string>());
  const unfinished = useRef(new Map<string, SessionResult>());
  const trigger = useRef<HTMLElement | null>(null);
  const draftKey = `work-map:new:${context?.id ?? "global"}`;
  const close = () => {
    if (pending.current) return;
    setContext(null);
    trigger.current?.focus({ preventScroll: true });
  };
  const open = (next: SessionContext) => {
    if (pending.current) return;
    trigger.current = document.activeElement as HTMLElement;
    const key = `work-map:request:${next.id}`;
    let saved = localRequests.current.get(key);
    try {
      saved = sessionStorage.getItem(key) ?? saved;
    } catch {
      /* Storage can be disabled by the host. */
    }
    requestId.current = saved ?? crypto.randomUUID();
    localRequests.current.set(key, requestId.current);
    try {
      sessionStorage.setItem(key, requestId.current);
    } catch {
      /* This mounted view still retains retry identity. */
    }
    setContext(next);
    let recovered = unfinished.current.get(next.id) ?? null;
    try {
      const stored = sessionStorage.getItem(`work-map:unfinished:${next.id}`);
      if (stored) recovered = sessionResultSchema.parse(JSON.parse(stored));
    } catch {
      /* Ignore an invalid or unavailable local receipt. */
    }
    setResult(recovered);
    setError("");
  };
  const rememberResult = (created: SessionResult) => {
    if (!context) return;
    setResult(created);
    const key = `work-map:request:${context.id}`;
    const unfinishedKey = `work-map:unfinished:${context.id}`;
    if (created.attachmentError) {
      unfinished.current.set(context.id, created);
      try {
        sessionStorage.setItem(unfinishedKey, JSON.stringify(created));
      } catch {
        /* Retained in this view. */
      }
    } else {
      unfinished.current.delete(context.id);
      localRequests.current.delete(key);
      try {
        sessionStorage.removeItem(key);
        sessionStorage.removeItem(unfinishedKey);
      } catch {
        /* Creation already succeeded. */
      }
    }
  };
  const submit = async (request: NewThreadRequest) => {
    if (pending.current || !context)
      throw new Error("Session creation is already in progress.");
    pending.current = true;
    setBusy(true);
    setError("");
    try {
      const created = await rpc.call("createSession", {
        requestId: requestId.current,
        request,
        ...(context.taskId ? { taskId: context.taskId } : {}),
      });
      rememberResult(created);
      onCreated();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      throw cause; // Native composer keeps the draft on failure.
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };
  const retryAttachment = async () => {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError("");
    try {
      rememberResult(
        await rpc.call("retrySessionAttachment", {
          requestId: requestId.current,
        }),
      );
      onCreated();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };
  const view = context && (
    <section
      className="wm-session-launcher"
      aria-label={
        result
          ? `Session in ${context.title}`
          : `New session in ${context.title}`
      }
      onKeyDown={(event) => {
        // Let native menus consume Escape first. Otherwise collapse only this layer.
        if (event.key === "Escape" && !event.defaultPrevented) {
          event.stopPropagation();
          close();
        }
      }}
    >
      <div className="wm-launcher-heading">
        <div>
          <h3>{result ? "Session" : "New session"}</h3>
          <p>
            {context.title}
            {context.taskId
              ? " · Attached to this task on start"
              : context.id !== "global"
                ? " · Project prompt · standalone session"
                : ""}
          </p>
        </div>
        <Button size="sm" variant="ghost" disabled={busy} onClick={close}>
          {result ? "Collapse session" : "Close draft"}
        </Button>
      </div>
      {error && (
        <p role="alert" className="wm-error">
          {error}
        </p>
      )}
      {result ? (
        <>
          {result.attachmentError && (
            <div role="alert" className="wm-error">
              <span>{result.attachmentError}</span>
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => void retryAttachment()}
              >
                Retry attachment
              </Button>
            </div>
          )}
          <Button
            size="sm"
            variant="outline"
            onClick={() => actions.open(result.threadId)}
          >
            Open full session
          </Button>
          <div className="wm-created-chat">
            <ThreadChat
              threadId={result.threadId}
              variant="compact"
              layout="contained"
              permissionPolicy="inherit"
              className="wm-live-chat"
            />
          </div>
        </>
      ) : (
        <>
          <NewThreadComposer
            key={draftKey}
            draftKey={draftKey}
            defaultProjectId={context.projectId}
            initialPrompt={context.prompt}
            placeholder="What would you like to work on?"
            layout="document"
            focusRequest={1}
            onSubmit={submit}
          />
          {busy && <p role="status">Starting session…</p>}
          <p className="wm-excerpt-note">
            {context.taskId
              ? "Starting also attaches this session to the task. "
              : ""}
            Your draft stays here when you close it.
          </p>
        </>
      )}
    </section>
  );
  return { context, open, close, busy, view, threadId: result?.threadId };
}
