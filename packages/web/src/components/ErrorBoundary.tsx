// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import { Component, Fragment, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
  /** Bumped on every "Try again" so the recovered subtree gets a fresh `key`
   *  (see render()) instead of just clearing `error` and re-rendering the same
   *  component instances in place. */
  retryKey: number;
}

/**
 * Top-level error boundary. The render path is heavily data-driven (transcript
 * entries, tool events, markdown → HTML), so a single malformed payload could
 * otherwise throw during render and unmount the whole app with a blank screen.
 * This catches that, shows a recoverable fallback, and keeps the shell alive.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, retryKey: 0 };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Keep a breadcrumb in the console for diagnosis; the fallback UI handles UX.
    console.error("Unhandled render error:", error, info.componentStack);
  }

  // Just clearing `error` re-renders the *same* child component instances —
  // if what threw was local component state (not just a one-off bad render),
  // "Try again" was a silent no-op: the tree re-rendered from the same state
  // and threw again immediately, but looked identical to a real recovery.
  // Bumping `retryKey` instead gives the recovered subtree a new `key`, so
  // React unmounts and remounts it from scratch — a genuine fresh start for
  // anything caused by bad local state. It can't fix corruption in the
  // external store (SessionStore lives outside this tree); that class of
  // error still needs Reload.
  retry = (): void => {
    this.setState((s) => ({ error: null, retryKey: s.retryKey + 1 }));
  };

  render(): ReactNode {
    const { error, retryKey } = this.state;
    if (!error) return <Fragment key={retryKey}>{this.props.children}</Fragment>;
    return (
      <div className="error-boundary" role="alert">
        <h1>Something went wrong</h1>
        <p>The app hit an unexpected error. Reloading usually fixes it.</p>
        <pre className="error-boundary__detail">{error.message}</pre>
        <div className="error-boundary__actions">
          <button type="button" onClick={this.retry}>
            Try again
          </button>
          <button type="button" onClick={() => window.location.reload()}>
            Reload
          </button>
        </div>
      </div>
    );
  }
}
