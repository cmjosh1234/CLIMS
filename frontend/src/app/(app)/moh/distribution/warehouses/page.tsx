import ShipmentsPage from '@/features/distribution/ShipmentsPage';
import { pageMetadata } from '@/navigation/pageMetadata';

export const metadata = pageMetadata('/moh/distribution/warehouses');

export default function Page() {
  return <ShipmentsPage />;
}
