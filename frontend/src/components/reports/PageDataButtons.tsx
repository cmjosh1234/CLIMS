'use client';

import { Download, FileSpreadsheet } from 'lucide-react';
import { useState, type RefObject } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { collectPageData, downloadPageCsv, downloadPageExcel } from '@/lib/export/pageData';

interface PageDataButtonsProps {
  /** The files' title and name, as the PDF's, e.g. "Overview". */
  title: string;
  subtitle?: string;
  /** The part of the page the files are made from: its figures, lists and charts' data. */
  targetRef: RefObject<HTMLElement | null>;
}

/**
 * "Download CSV" and "Export Excel" for a page with no server export: the headline figures, the
 * lists and every chart's data as they stand, with the period and filters. Excel puts each table
 * on its own sheet; the CSV stacks them under their titles.
 */
export function PageDataButtons({ title, subtitle, targetRef }: PageDataButtonsProps) {
  const [busy, setBusy] = useState<'csv' | 'excel' | null>(null);

  const run = async (kind: 'csv' | 'excel') => {
    const target = targetRef.current;
    if (!target) return;
    const data = collectPageData(target, title, subtitle);
    if (data.tables.length === 0) {
      toast.error('Nothing to download yet. Wait for the figures to load, then try again.');
      return;
    }
    setBusy(kind);
    try {
      if (kind === 'csv') downloadPageCsv(data);
      else await downloadPageExcel(data);
    } catch (error) {
      console.error(`${kind} download failed`, error);
      toast.error(`Could not create the ${kind === 'csv' ? 'CSV' : 'Excel'} file. Try again.`);
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <Button variant="outline" disabled={busy !== null} onClick={() => void run('csv')}>
        {busy === 'csv' ? (
          <Spinner data-icon="inline-start" aria-hidden="true" />
        ) : (
          <Download data-icon="inline-start" />
        )}
        Download CSV
      </Button>
      <Button variant="outline" disabled={busy !== null} onClick={() => void run('excel')}>
        {busy === 'excel' ? (
          <Spinner data-icon="inline-start" aria-hidden="true" />
        ) : (
          <FileSpreadsheet data-icon="inline-start" />
        )}
        Export Excel
      </Button>
    </>
  );
}
