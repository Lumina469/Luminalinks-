export const calculateETA = (distanceKm: number) => {
  const averageSpeedKmH = 30; // Average speed in Ghana city traffic
  const timeHours = distanceKm / averageSpeedKmH;
  const timeMinutes = Math.round(timeHours * 60);
  
  if (timeMinutes < 1) return "Arriving now";
  return `${timeMinutes} mins`;
};

export const getTrafficMultiplier = (hour: number) => {
  // Peak rush hour in Ghana (7-9 AM and 4-7 PM)
  if ((hour >= 7 && hour <= 9) || (hour >= 16 && hour <= 19)) {
    return 1.5; // 50% slower
  }
  return 1.0;
};
