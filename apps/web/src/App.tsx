import { ApiStatus } from './components/ApiStatus';

const apiBaseUrl = import.meta.env.VITE_API_BASE_URL ?? '/api';

export function App() {
  return (
    <div className="shell">
      <header className="shell__header">
        <div className="brand">
          <span className="brand__mark" aria-hidden="true">
            H
          </span>
          <div>
            <p className="brand__name">HOS</p>
            <p className="brand__tagline">Hotel operating system by Leptron</p>
          </div>
        </div>
        <ApiStatus baseUrl={apiBaseUrl} />
      </header>

      <main className="shell__main">
        <section className="panel" aria-labelledby="welcome-heading">
          <h1 id="welcome-heading">Platform foundation</h1>
          <p>
            This is the HOS application shell. Hotel modules will appear here as each one is
            delivered.
          </p>
        </section>
      </main>

      <footer className="shell__footer">
        <span>© Leptron</span>
      </footer>
    </div>
  );
}
