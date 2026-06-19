export const addRideToHistory = (completedRide: any, currentHistory: any[]) => {
  return [...currentHistory, { ...completedRide, completedAt: new Date().toISOString() }];
};

export const calculateAverageRating = (ratings: number[]) => {
  if (ratings.length === 0) return 5.0;
  const sum = ratings.reduce((a, b) => a + b, 0);
  return (sum / ratings.length).toFixed(1);
};
