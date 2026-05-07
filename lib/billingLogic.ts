/**
 * LuminaLinks Automated Billing & Commission
 */
export function calculatePayout(
  startTime: Date, 
  endTime: Date, 
  hourlyRate: number, 
  baseFee: number
) {
  const durationMs = endTime.getTime() - startTime.getTime();
  const durationHours = Math.max(durationMs / (1000 * 60 * 60), 0.5);

  const totalCharged = baseFee + (durationHours * hourlyRate);
  
  // 10% Lumina Commission
  const commission = totalCharged * 0.10;
  const proEarnings = totalCharged - commission;

  return {
    totalToClient: Math.round(totalCharged * 100) / 100,
    luminaCommission: Math.round(commission * 100) / 100,
    proFinalTakeHome: Math.round(proEarnings * 100) / 100
  };
}

