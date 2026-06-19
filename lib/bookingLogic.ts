export const acceptRide = (rideId: string, driverId: string, currentBookings: any[]) => {
  return currentBookings.map((ride) => {
    if (ride.id === rideId) {
      return { 
        ...ride, 
        status: "accepted", 
        driverId: driverId,
        acceptedAt: new Date().toISOString() 
      };
    }
    return ride;
  });
};

export const filterAvailableRides = (allRides: any[]) => {
  return allRides.filter(ride => ride.status === "pending");
};
