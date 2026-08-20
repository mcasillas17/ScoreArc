'use client';

import { useLanguage } from './LanguageProvider';

export default function SiteFooter() {
  const { language, setLanguage } = useLanguage();
  const spanish = language === 'es';

  return (
    <footer className="site-footer">
      <p>{spanish ? 'ScoreArc · Datos vía ESPN · No afiliado con FIFA' : 'ScoreArc · Data via ESPN · Not affiliated with FIFA'}</p>
      <div className="language-toggle" role="group" aria-label={spanish ? 'Idioma' : 'Language'}>
        <button type="button" className={spanish ? '' : 'language-toggle--active'} onClick={() => setLanguage('en')} aria-pressed={!spanish}>
          EN
        </button>
        <span aria-hidden="true">/</span>
        <button type="button" className={spanish ? 'language-toggle--active' : ''} onClick={() => setLanguage('es')} aria-pressed={spanish}>
          ES
        </button>
      </div>
    </footer>
  );
}
