import ConsumptionPage from '@/features/consumption/ConsumptionPage';
import { pageMetadata } from '@/navigation/pageMetadata';

export const metadata = pageMetadata('/dcfp/reports');

export default function Page() {
  return <ConsumptionPage workspace="dcfp" />;
}
