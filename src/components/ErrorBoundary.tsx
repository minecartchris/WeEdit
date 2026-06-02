import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

// Surface runtime errors as a visible panel instead of letting React unmount
// the whole tree to a blank page. Click reset to retry the render.
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("WeEdit crashed:", error, info);
  }

  reset = () => this.setState({ error: null });

  render() {
    if (this.state.error) {
      return (
        <div className="h-full w-full grid place-items-center bg-we-rail p-8">
          <div className="max-w-2xl w-full rounded-lg border border-red-200 bg-we-panel shadow-sm overflow-hidden">
            <div className="px-5 py-3 bg-red-50 border-b border-red-100 text-red-800 font-medium">
              Something went wrong
            </div>
            <div className="p-5 space-y-3 text-sm">
              <p className="text-we-ink">
                The editor hit a runtime error. Your unsaved work may be lost.
              </p>
              <pre className="bg-we-hover rounded p-3 text-xs overflow-auto max-h-72 whitespace-pre-wrap">
                {this.state.error.name}: {this.state.error.message}
                {this.state.error.stack ? `\n\n${this.state.error.stack}` : ""}
              </pre>
              <div className="flex gap-2">
                <button onClick={this.reset} className="we-btn-primary">Reset and retry</button>
                <button onClick={() => window.location.reload()} className="we-btn">Reload window</button>
              </div>
            </div>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
