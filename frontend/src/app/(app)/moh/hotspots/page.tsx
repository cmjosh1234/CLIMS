import NationalHotspotsPage from '@/features/hotspots/NationalHotspotsPage';
import { pageMetadata } from '@/navigation/pageMetadata';

export const metadata = pageMetadata('/moh/hotspots');

export default function Page() {
  return <NationalHotspotsPage />;
}
