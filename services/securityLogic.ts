export const securityProtocol = {
  // SOS Alert System
  emitSOS: (userId: string, coords: {lat: number, lon: number}) => {
    return {
      alertType: "POLICE_DISPATCH",
      userId,
      location: `https://maps.google.com/?q=${coords.lat},${coords.lon}`,
      priority: "CRITICAL",
      timestamp: new Date().toLocaleTimeString()
    };
  },

  // Fraud Detection (Ghost Rides)
  detectGhostRide: (startTime: number, endTime: number, distance: number) => {
    const durationMinutes = (endTime - startTime) / 60000;
    if (distance > 0 && durationMinutes < 1) return "FRAUD_DETECTED: TRAVEL_TOO_FAST";
    return "VALID_TRIP";
  }
};
