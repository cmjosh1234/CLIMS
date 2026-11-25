import { expect, test } from '@playwright/test';

import { resetMock } from './support/mock';
import { expectToast, open } from './support/ui';

/*
 * The DCFP's October report (RPT-2610-WAKISO). CLIMS fills in opening, received and issued:
 * male 8,200 + 6,000 − 11,600 and female 300 + 200 − 360, so with no losses the closing
 * balances must be 2,600 and 140.
 */

test.beforeEach(async ({ request }) => {
  await resetMock(request);
});

test('a report that does not balance is held back until it is corrected, then sent', async ({
  page,
}) => {
  await open(page, '/dcfp/reports', 'Monthly reports');
  await page.getByRole('link', { name: 'Start report' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Monthly report' })).toBeVisible();

  await page
    .getByRole('textbox', { name: 'Male condoms, Losses & adjustments', exact: true })
    .fill('0');
  await page
    .getByRole('textbox', { name: 'Female condoms, Losses & adjustments', exact: true })
    .fill('0');
  const maleClosing = page.getByRole('textbox', {
    name: 'Male condoms, Closing balance',
    exact: true,
  });
  await maleClosing.fill('2500');
  await page
    .getByRole('textbox', { name: 'Female condoms, Closing balance', exact: true })
    .fill('140');
  await page.getByRole('textbox', { name: 'Days the store was out of stock' }).fill('0');

  await page.getByRole('button', { name: 'Validate and send' }).click();
  await expect(page.getByText('1 error to fix before this report can be sent')).toBeVisible();
  await expect(
    page.getByText(/Doesn't balance: opening \+ received − issued − losses = 2,600/).first(),
  ).toBeVisible();
  await expect(maleClosing).toHaveAttribute('aria-invalid', 'true');
  await expect(page.getByRole('button', { name: 'Re-check and send' })).toBeVisible();

  // The check runs live once it has run: fixing the figure clears the error and the label.
  await maleClosing.fill('2600');
  await expect(maleClosing).not.toHaveAttribute('aria-invalid', 'true');
  await page.getByRole('button', { name: 'Validate and send' }).click();

  await expectToast(page, /^October 2026 report sent to MOH\./);
  await expect(
    page.getByRole('region', { name: 'October 2026 · District stock report' }),
  ).not.toContainText('Draft');
});

test('saves a draft and keeps the figures', async ({ page }) => {
  await open(page, '/dcfp/reports/RPT-2610-WAKISO', 'Monthly report');
  await page
    .getByRole('textbox', { name: 'Male condoms, Closing balance', exact: true })
    .fill('2600');
  await page.getByRole('button', { name: 'Save draft' }).click();

  await expectToast(page, 'Draft saved.');
  await page.reload();
  await expect(
    page.getByRole('textbox', { name: 'Male condoms, Closing balance', exact: true }),
  ).toHaveValue('2600');
});
