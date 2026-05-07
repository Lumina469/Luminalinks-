export const calculateDriverPayout = (totalFare: number, customCommission?: number) => {
  // Uses Admin-adjusted rate if provided, otherwise defaults to 15%
  const platformCommissionRate = customCommission !== undefined ? customCommission : 0.15; 
  const commission = totalFare * platformCommissionRate;
  const driverEarnings = totalFare - commission;
  
  return {
    total: totalFare.toFixed(2),
    commission: commission.toFixed(2),
    payout: driverEarnings.toFixed(2),
    rateUsed: (platformCommissionRate * 100) + "%"
  };
};

export const aggregateDailyEarnings = (completedRides: any[]) => {
  return completedRides.reduce((sum, ride) => sum + parseFloat(ride.fare), 0).toFixed(2);
};
