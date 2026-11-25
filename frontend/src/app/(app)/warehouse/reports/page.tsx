import ConsumptionPage from '@/features/consumption/ConsumptionPage';
import { pageMetadata } from '@/navigation/pageMetadata';

export const metadata = pageMetadata('/warehouse/reports');

export default function Page() {
  return <ConsumptionPage workspace="warehouse" />;
}
