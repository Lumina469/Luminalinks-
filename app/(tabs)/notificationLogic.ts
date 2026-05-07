export const formatRideNotification = (ride: any) => {
  return {
    title: "New Ride Request! 🚗",
    body: `Pickup: ${ride.pickup} -> Dropoff: ${ride.dropoff}. Est. Fare: GHS ${ride.baseFare}`,
    data: { rideId: ride.id }
  };
};

export const playNotificationSound = () => {
  // Placeholder for the "Ping" sound logic to be implemented on the new device
  console.log("🔊 Playing: New_Order_Ping.mp3");
};
