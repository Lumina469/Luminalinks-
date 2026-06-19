import { getDistance } from './geoUtils';

interface Professional {
  id: string;
  name: string;
  lat: number;
  lon: number;
  is_verified: boolean; // Gold Badge status
  is_online: boolean;
}

/**
 * Automatically finds the top 3 verified pros within 5km.
 */
export function findNearestPros(
  clientLat: number, 
  clientLon: number, 
  pros: Professional[]
) {
  return pros
    .filter(pro => pro.is_online && pro.is_verified) // Only verified & online
    .map(pro => ({
      ...pro,
      distance: getDistance(clientLat, clientLon, pro.lat, pro.lon)
    }))
    // Filter for pros within 5km (cleaning the " km away" string back to number)
    .filter(pro => parseFloat(pro.distance) <= 5.0)
    .sort((a, b) => parseFloat(a.distance) - parseFloat(b.distance))
    .slice(0, 3); // Auto-pick top 3
}

