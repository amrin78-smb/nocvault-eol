'use client';

import { useState } from 'react';

interface ScrapeButtonProps {
  slug: string;
  manualOnly: boolean;
}

export default function ScrapeButton({ slug, manualOnly }: ScrapeButtonProps) {
  const [loading, setLoading] = useState(false);

  if (manualOnly) {
    return (
      <button className="btn btn-sm btn-disabled" disabled>
        Scrape Now
      </button>
    );
  }

  async function handleClick() {
    setLoading(true);
    try {
      await fetch('/api/admin/scrape/' + slug, { method: 'POST' });
      window.location.reload();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Scrape failed';
      alert(message);
      setLoading(false);
    }
  }

  return (
    <button
      className="btn btn-sm btn-primary"
      onClick={handleClick}
      disabled={loading}
    >
      {loading ? 'Scraping...' : 'Scrape Now'}
    </button>
  );
}
