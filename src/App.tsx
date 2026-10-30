import { useEffect, useState } from 'react'
import EmbedderPage from './pages/EmbedderPage'
import ScannerPage from './pages/ScannerPage'
import LibraryPage from './pages/LibraryPage'
import MobileGate from './components/MobileGate'

type Tab = 'embed' | 'scan' | 'library'
type Lang = 'TR' | 'EN'

const LANG_KEY = 'aruco-embedder-lang'

/** English by default; remembers the user's last choice. */
function initialLang(): Lang {
  try {
    return localStorage.getItem(LANG_KEY) === 'TR' ? 'TR' : 'EN'
  } catch {
    return 'EN'
  }
}

const TABS = {
  embed:   { TR: '🛠 Gömücü',    EN: '🛠 Embedder' },
  scan:    { TR: '📷 Tarayıcı',  EN: '📷 Scanner' },
  library: { TR: '📚 Kütüphane', EN: '📚 Library' },
}

export default function App() {
  const [tab, setTab] = useState<Tab>('embed')
  const [lang, setLang] = useState<Lang>(initialLang)
  const [libraryRefreshKey, setLibraryRefreshKey] = useState(0)

  useEffect(() => {
    document.documentElement.lang = lang === 'TR' ? 'tr' : 'en'
    try { localStorage.setItem(LANG_KEY, lang) } catch { /* storage unavailable */ }
  }, [lang])

  return (
    <div className="flex flex-col h-full">

      {/* Phone / tablet notice — only shown on mobile devices */}
      <MobileGate lang={lang} />

      {/* Navbar */}
      <header className="shrink-0 flex items-center gap-2 px-4 py-3 border-b border-neutral-800 bg-neutral-950">
        <div className="flex items-center mr-4">
          <span className="text-sm font-semibold text-neutral-100 hidden sm:inline">
            ArUco Embedder
          </span>
        </div>

        <nav className="flex gap-1 flex-1">
          {(Object.keys(TABS) as Tab[]).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`
                px-3 py-1.5 rounded-lg text-sm font-medium transition-colors
                ${tab === t
                  ? 'bg-neutral-800 text-neutral-100'
                  : 'text-neutral-500 hover:text-neutral-300 hover:bg-neutral-900'}
              `}
            >
              {TABS[t][lang]}
            </button>
          ))}
        </nav>

        <button
          onClick={() => setLang(l => l === 'TR' ? 'EN' : 'TR')}
          className="shrink-0 text-xs text-neutral-500 hover:text-neutral-300 bg-neutral-900 hover:bg-neutral-800 border border-neutral-800 px-2 py-1 rounded-lg transition-colors"
        >
          {lang === 'TR' ? 'EN' : 'TR'}
        </button>
      </header>

      {/* Tabs are never unmounted — inactive ones are hidden with display:none,
          so the Embedder state (loaded STL, preset choice, slider values)
          and the Three.js scene survive tab switches. */}
      <main className="flex-1 overflow-hidden">
        <div className={`h-full overflow-y-auto ${tab === 'embed' ? 'flex' : 'hidden'}`}><EmbedderPage lang={lang} onEmbedComplete={() => setLibraryRefreshKey(k => k + 1)} /></div>
        <div className={`h-full overflow-y-auto ${tab === 'scan'    ? 'block' : 'hidden'}`}><ScannerPage  lang={lang} /></div>
        <div className={`h-full overflow-y-auto ${tab === 'library' ? 'block' : 'hidden'}`}><LibraryPage  lang={lang} refreshKey={libraryRefreshKey} /></div>
      </main>

      <footer className="shrink-0 text-center text-xs text-neutral-800 py-2 border-t border-neutral-900">
        ArUco Embedder by Kağan ŞAHİN
      </footer>
    </div>
  )
}
