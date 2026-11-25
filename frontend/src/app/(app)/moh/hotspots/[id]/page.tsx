import HotspotPage from '@/features/hotspots/HotspotPage';
import { MOH_HOTSPOTS_PATH } from '@/features/hotspots/NationalHotspotsPage';
import { pageMetadata } from '@/navigation/pageMetadata';

export const metadata = pageMetadata('/moh/hotspots/[id]');

export default function Page() {
  return <HotspotPage backHref={MOH_HOTSPOTS_PATH} />;
}
