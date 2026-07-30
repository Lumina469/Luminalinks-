import React, { useState, useRef, useEffect } from "react";
import { WebView } from "react-native-webview";
import { supabase } from '../../lib/supabase';
import {
  View, Text, ScrollView, TouchableOpacity, StyleSheet,
  TextInput, Alert, Switch, Image, Linking, Animated, RefreshControl
} from "react-native";
import * as Location from "expo-location";
import { SafeAreaView } from "react-native-safe-area-context";
import * as ImagePicker from "expo-image-picker";
import * as Notifications from "expo-notifications";
import Constants from "expo-constants";
import { Ionicons, MaterialCommunityIcons } from "@expo/vector-icons";
import * as SplashScreen from "expo-splash-screen";
import { useFonts, Manrope_600SemiBold, Manrope_700Bold, Manrope_800ExtraBold } from "@expo-google-fonts/manrope";
import * as Haptics from "expo-haptics";

SplashScreen.preventAutoHideAsync();

// Custom illustrated service icons (replacing the generic vector icons)
const ICON_CAR = require("../../assets/icons/car.png");
const ICON_TUKTUK = require("../../assets/icons/tuktuk.png");
const ICON_MOTORBIKE = require("../../assets/icons/motorbike.png");
const ICON_HOURLY = require("../../assets/icons/hourly.png");
const ICON_FOOD = require("../../assets/icons/food.png");

// ============================================================
// UTILITIES
// ============================================================
const searchPlaces = async (q: string) => {
  if (!q || q.length < 3) return [];
  try {
    const r = await fetch(
      "https://nominatim.openstreetmap.org/search?format=json" +
      "&countrycodes=gh" +           // Ghana only
      "&limit=8" +                  // enough options, faster response
      "&addressdetails=1" +
      "&dedupe=1" +
      "&q=" + encodeURIComponent(q),
      { headers: { "User-Agent": "Luma/1.0" } }
    );
    const data = await r.json();
    return data.map((p: any) => {
      // Build a shorter, cleaner label instead of the very long full display_name
      const a = p.address || {};
      const primary = p.name || a.road || a.suburb || a.neighbourhood || a.village || a.town || (p.display_name || "").split(",")[0];
      const area = a.suburb || a.neighbourhood || a.town || a.city || a.municipality || a.county || "";
      const shortName = [primary, area].filter(Boolean).filter((v, i, arr) => arr.indexOf(v) === i).join(", ");
      return {
        name: shortName || p.display_name,
        fullName: p.display_name,
        lat: parseFloat(p.lat),
        lon: parseFloat(p.lon),
      };
    });
  } catch (e) { return []; }
};

const reverseGeocode = async (lat: number, lon: number) => {
  try {
    const r = await fetch(
      `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lon}&zoom=18`,
      { headers: { "User-Agent": "Luma/1.0" } }
    );
    const data = await r.json();
    return data.display_name || `${lat.toFixed(4)}, ${lon.toFixed(4)}`;
  } catch (e) {
    return `${lat.toFixed(4)}, ${lon.toFixed(4)}`;
  }
};

const getDist = (lat1: number, lon1: number, lat2: number, lon2: number) => {
  if (!lat1 || !lon1 || !lat2 || !lon2) return 0;
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
};

// Wrapped in try/catch since haptics can fail silently on some devices/emulators
// without haptic hardware — never worth crashing or blocking a real action over.
const haptic = (style: "light" | "medium" | "success" | "warning" | "error" = "light") => {
  try {
    if (style === "success") Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    else if (style === "warning") Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
    else if (style === "error") Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    else if (style === "medium") Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    else Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  } catch (e) { /* no haptics hardware — silently ignore */ }
};

const timeAgo = (isoString: string) => {
  const diffMs = Date.now() - new Date(isoString).getTime();
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return "Just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(isoString).toLocaleDateString();
};

// ============================================================
// FARE CALCULATION — Blueprint v4.0
// Car: GHS 5 base + GHS 8/km, min GHS 20
// Tuk Tuk: GHS 3 base + GHS 5/km, min GHS 10
// Motorbike: GHS 4 base + GHS 6/km, min GHS 15
// ============================================================
// ============================================================
// PLATFORM SETTINGS — loaded from Supabase system_settings table
// Falls back to these blueprint defaults if the table is empty/unreachable,
// so the app always works even before settings have been loaded.
// ============================================================
let PLATFORM_SETTINGS = {
  platform_commission: 0.15,
  food_commission: 0.10, // Blueprint: 10% of food bill (distinct from the 15% ride/delivery-fee commission)
  surge_threshold_moderate: 3,
  surge_multiplier_moderate: 1.1,
  surge_threshold_busy: 5,
  surge_multiplier_busy: 1.25,
  surge_threshold_high: 10,
  surge_multiplier_high: 1.5,
  car_min_fare: 20,
  tuktuk_min_fare: 10,
  motorbike_min_fare: 15,
  night_mult_evening: 1.2,
  night_mult_night: 1.5,
  night_mult_late: 2.0,
  night_mult_early: 1.5,
  founder_code: "F0UN-D3R-LNK-X9Q2",
  founder_discount: 100,
  staff_code: "LUMINA-STAFF-2026",
  staff_discount: 50,
  birthday_mode_active: 0,
  maintenance_mode_active: 0,
};

const loadPlatformSettings = async () => {
  try {
    const { data } = await supabase.from("system_settings").select("key, value, text_value");
    if (data) {
      data.forEach((row: any) => {
        if (row.key === "founder_code") {
          if (row.text_value) PLATFORM_SETTINGS.founder_code = row.text_value;
          if (row.value != null) PLATFORM_SETTINGS.founder_discount = row.value;
        } else if (row.key === "staff_code") {
          if (row.text_value) PLATFORM_SETTINGS.staff_code = row.text_value;
          if (row.value != null) PLATFORM_SETTINGS.staff_discount = row.value;
        } else if (row.key in PLATFORM_SETTINGS) {
          (PLATFORM_SETTINGS as any)[row.key] = row.value;
        }
      });
    }
  } catch (e) {
    console.log("Could not load platform settings, using defaults:", e);
  }
};

const getNightMultiplier = () => {
  const hour = new Date().getHours();
  if (hour >= 6 && hour < 20) return { multiplier: 1.0, label: "Standard Hours", color: "#2DD4BF" };
  if (hour >= 20 && hour < 22) return { multiplier: PLATFORM_SETTINGS.night_mult_evening, label: `Evening x${PLATFORM_SETTINGS.night_mult_evening}`, color: "#F5A623" };
  if (hour >= 22 && hour < 24) return { multiplier: PLATFORM_SETTINGS.night_mult_night, label: `Night x${PLATFORM_SETTINGS.night_mult_night}`, color: "#f5a623" };
  if (hour >= 0 && hour < 4) return { multiplier: PLATFORM_SETTINGS.night_mult_late, label: `Late Night x${PLATFORM_SETTINGS.night_mult_late}`, color: "#F87171" };
  if (hour >= 4 && hour < 6) return { multiplier: PLATFORM_SETTINGS.night_mult_early, label: `Early Morning x${PLATFORM_SETTINGS.night_mult_early}`, color: "#f5a623" };
  return { multiplier: 1.0, label: "Standard Hours", color: "#2DD4BF" };
};

const calcFare = (km: number, service: string = "car", pendingCount: number = 0) => {
  const surgeMultiplier =
    pendingCount >= PLATFORM_SETTINGS.surge_threshold_high ? PLATFORM_SETTINGS.surge_multiplier_high :
    pendingCount >= PLATFORM_SETTINGS.surge_threshold_busy ? PLATFORM_SETTINGS.surge_multiplier_busy :
    pendingCount >= PLATFORM_SETTINGS.surge_threshold_moderate ? PLATFORM_SETTINGS.surge_multiplier_moderate : 1.0;

  const { multiplier: nightMultiplier } = getNightMultiplier();

  // Both surge and night pricing apply — highest multiplier wins per blueprint
  // "Surge pricing only increases never decreases"
  const finalMultiplier = Math.max(surgeMultiplier, nightMultiplier);

  let base = 5.0, perKm = 8.0, minFare = PLATFORM_SETTINGS.car_min_fare;
  if (service === "tuktuk") { base = 3.0; perKm = 5.0; minFare = PLATFORM_SETTINGS.tuktuk_min_fare; }
  if (service === "motorbike") { base = 4.0; perKm = 6.0; minFare = PLATFORM_SETTINGS.motorbike_min_fare; }

  const fare = Math.max(minFare, base + km * perKm) * finalMultiplier;
  const commission = fare * PLATFORM_SETTINGS.platform_commission;
  const driverEarns = fare - commission;
  return { fare: parseFloat(fare.toFixed(2)), commission: parseFloat(commission.toFixed(2)), driverEarns: parseFloat(driverEarns.toFixed(2)) };
};

const getSurgeLabel = (pendingCount: number) => {
  if (pendingCount >= PLATFORM_SETTINGS.surge_threshold_high) return { label: `High Demand x${PLATFORM_SETTINGS.surge_multiplier_high}`, color: "#F87171" };
  if (pendingCount >= PLATFORM_SETTINGS.surge_threshold_busy) return { label: `Busy x${PLATFORM_SETTINGS.surge_multiplier_busy}`, color: "#F5A623" };
  if (pendingCount >= PLATFORM_SETTINGS.surge_threshold_moderate) return { label: `Moderate x${PLATFORM_SETTINGS.surge_multiplier_moderate}`, color: "#f5a623" };
  return { label: "Normal Price", color: "#2DD4BF" };
};

// ============================================================
// RIDE SCHEDULING — Blueprint: up to 7 days ahead
// ============================================================
const getNext7Days = () => {
  const days = [];
  const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  for (let i = 0; i < 8; i++) {
    const d = new Date();
    d.setDate(d.getDate() + i);
    days.push({
      key: d.toISOString().split("T")[0],
      label: i === 0 ? "Today" : i === 1 ? "Tomorrow" : dayNames[d.getDay()],
      date: `${d.getDate()}/${d.getMonth() + 1}`,
    });
  }
  return days;
};

const getTimeSlots = (dayKey: string) => {
  const slots = [];
  const isToday = dayKey === new Date().toISOString().split("T")[0];
  const currentHour = new Date().getHours();
  for (let h = 5; h <= 22; h++) {
    // For today, only show future slots (at least 1 hour ahead)
    if (isToday && h <= currentHour + 1) continue;
    const label = h < 12 ? `${h}:00 AM` : h === 12 ? "12:00 PM" : `${h - 12}:00 PM`;
    slots.push({ key: `${String(h).padStart(2, "0")}:00`, label });
  }
  return slots;
};

// ============================================================
// PUSH NOTIFICATIONS
// ============================================================
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldPlaySound: true,
    shouldSetBadge: false,
    shouldShowBanner: true,
    shouldShowList: true,
  }),
});

const sendPushNotification = async (pushToken: string, title: string, body: string, userId?: string) => {
  // Save to in-app notification history first — this works even if the push
  // token is missing/stale/invalid, so the notification isn't lost either way.
  if (userId) {
    try {
      await supabase.from("notifications").insert({ user_id: userId, title, body });
    } catch (e) {
      console.log("Could not save notification history:", e);
    }
  }
  if (!pushToken) return;
  try {
    await fetch("https://exp.host/--/api/v2/push/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ to: pushToken, title, body, sound: "default" }),
    });
  } catch (e) {
    console.log("Push notification failed:", e);
  }
};

const registerForPushNotifications = async (): Promise<string | null> => {
  try {
    const { status: existingStatus } = await Notifications.getPermissionsAsync();
    let finalStatus = existingStatus;
    if (existingStatus !== "granted") {
      const { status } = await Notifications.requestPermissionsAsync();
      finalStatus = status;
    }
    if (finalStatus !== "granted") return null;

    const projectId = Constants?.expoConfig?.extra?.eas?.projectId;
    const tokenData = projectId
      ? await Notifications.getExpoPushTokenAsync({ projectId })
      : await Notifications.getExpoPushTokenAsync();
    return tokenData.data;
  } catch (e) {
    console.log("Push registration failed:", e);
    return null;
  }
};

// ============================================================
// MAIN APP
// ============================================================
// ============================================================
// BRAND WORDMARK — the "link" mark: two nodes joined by a bar,
// representing the connection Luma makes (rider↔driver, sender↔receiver).
// Built from Views so it needs no extra SVG dependency.
// ============================================================
const LinkMark = ({ size = 26 }: { size?: number }) => {
  const node = size * 0.42;
  const bar = size * 0.12;
  return (
    <View style={{ width: size, height: node, flexDirection: "row", alignItems: "center", justifyContent: "center" }}>
      <View style={{ width: node, height: node, borderRadius: node / 2, backgroundColor: "#2DD4BF" }} />
      <View style={{ width: size * 0.24, height: bar, backgroundColor: "#2DD4BF", marginHorizontal: -bar / 2 }} />
      <View style={{ width: node, height: node, borderRadius: node / 2, backgroundColor: "#F4F6FB" }} />
    </View>
  );
};

const Wordmark = ({ fontSize = 20, showMark = true }: { fontSize?: number; showMark?: boolean }) => (
  <View style={{ flexDirection: "row", alignItems: "center", gap: fontSize * 0.35 }}>
    {showMark && <LinkMark size={fontSize * 1.25} />}
    <Text style={{ fontSize, fontFamily: "Manrope_800ExtraBold", color: "#F4F6FB", letterSpacing: -0.5 }}>Luma</Text>
  </View>
);

// A small branded loading indicator — the link-mark's teal node gently pulses.
const Pulse = ({ label, size = 40 }: { label?: string; size?: number }) => {
  const scale = useRef(new Animated.Value(0.7)).current;
  const opacity = useRef(new Animated.Value(0.4)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.parallel([
          Animated.timing(scale, { toValue: 1, duration: 650, useNativeDriver: true }),
          Animated.timing(opacity, { toValue: 1, duration: 650, useNativeDriver: true }),
        ]),
        Animated.parallel([
          Animated.timing(scale, { toValue: 0.7, duration: 650, useNativeDriver: true }),
          Animated.timing(opacity, { toValue: 0.4, duration: 650, useNativeDriver: true }),
        ]),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, []);
  return (
    <View style={{ alignItems: "center", justifyContent: "center", paddingVertical: 24 }}>
      <Animated.View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: "#2DD4BF", transform: [{ scale }], opacity }} />
      {label ? <Text style={{ color: "#8A9BB8", fontSize: 13, marginTop: 14 }}>{label}</Text> : null}
    </View>
  );
};

// A branded empty state — icon in a soft teal disc, a headline, and a warm line of copy.
const EmptyState = ({ icon, title, subtitle }: { icon: any; title: string; subtitle: string }) => (
  <View style={{ alignItems: "center", justifyContent: "center", paddingVertical: 48, paddingHorizontal: 24 }}>
    <View style={{ width: 76, height: 76, borderRadius: 38, backgroundColor: "#2DD4BF18", alignItems: "center", justifyContent: "center", marginBottom: 18 }}>
      <Ionicons name={icon} size={34} color="#2DD4BF" />
    </View>
    <Text style={{ color: "#F4F6FB", fontSize: 17, fontWeight: "700", textAlign: "center", marginBottom: 6 }}>{title}</Text>
    <Text style={{ color: "#8A9BB8", fontSize: 13, textAlign: "center", lineHeight: 19 }}>{subtitle}</Text>
  </View>
);

// A pressable wrapper that gently scales down on touch — the small motion detail
// that makes taps feel responsive and "designed" instead of just a flat color change.
const Tappable = ({ onPress, style, children, disabled }: { onPress?: () => void; style?: any; children: React.ReactNode; disabled?: boolean }) => {
  const scale = useRef(new Animated.Value(1)).current;
  const pressIn = () => Animated.spring(scale, { toValue: 0.96, useNativeDriver: true, speed: 40, bounciness: 6 }).start();
  const pressOut = () => Animated.spring(scale, { toValue: 1, useNativeDriver: true, speed: 40, bounciness: 6 }).start();
  return (
    <TouchableOpacity activeOpacity={0.9} disabled={disabled} onPress={onPress} onPressIn={pressIn} onPressOut={pressOut}>
      <Animated.View style={[style, { transform: [{ scale }] }]}>{children}</Animated.View>
    </TouchableOpacity>
  );
};

// A small staggered fade+rise entrance — used to bring lists/grids in with a
// bit of life instead of just appearing instantly.
const FadeInUp = ({ index = 0, children, style }: { index?: number; children: React.ReactNode; style?: any }) => {
  const opacity = useRef(new Animated.Value(0)).current;
  const translateY = useRef(new Animated.Value(14)).current;
  useEffect(() => {
    Animated.parallel([
      Animated.timing(opacity, { toValue: 1, duration: 320, delay: index * 60, useNativeDriver: true }),
      Animated.timing(translateY, { toValue: 0, duration: 320, delay: index * 60, useNativeDriver: true }),
    ]).start();
  }, []);
  return <Animated.View style={[style, { opacity, transform: [{ translateY }] }]}>{children}</Animated.View>;
};

export default function App() {
  const [fontsLoaded] = useFonts({
    Manrope_600SemiBold,
    Manrope_700Bold,
    Manrope_800ExtraBold,
  });

  useEffect(() => {
    if (fontsLoaded) SplashScreen.hideAsync();
  }, [fontsLoaded]);

  // Navigation
  const [screen, setScreen] = useState("welcome");
  const go = (s: string) => setScreen(s);

  // Auth state
  const [user, setUser] = useState<any>(null);
  const [authMode, setAuthMode] = useState("login");
  const [authRole, setAuthRole] = useState<string | null>(null);
  const [authName, setAuthName] = useState("");
  const [authEmail, setAuthEmail] = useState("");
  const [authPhone, setAuthPhone] = useState("");
  const [authPass, setAuthPass] = useState("");
  const [authConfirm, setAuthConfirm] = useState("");
  const [emailOtpCode, setEmailOtpCode] = useState("");
  const [verifyingCode, setVerifyingCode] = useState(false);
  const [uploadingKycDocs, setUploadingKycDocs] = useState(false);
  const [driverRefCode, setDriverRefCode] = useState("");

  // KYC / Verification
  const [idPhoto, setIdPhoto] = useState<string | null>(null);
  const [licFront, setLicFront] = useState<string | null>(null);
  const [licBack, setLicBack] = useState<string | null>(null);
  const [selfiePhoto, setSelfiePhoto] = useState<string | null>(null);
  const [vehiclePhoto, setVehiclePhoto] = useState<string | null>(null);
  const [foodSafetyCert, setFoodSafetyCert] = useState<string | null>(null);
  const [restaurantPhoto, setRestaurantPhoto] = useState<string | null>(null);
  const [businessName, setBusinessName] = useState("");
  const [vehMake, setVehMake] = useState("");
  const [vehModel, setVehModel] = useState("");
  const [vehYear, setVehYear] = useState("");
  const [vehPlate, setVehPlate] = useState("");
  const [vehColor, setVehColor] = useState("");
  const [roadWorthyExpiry, setRoadWorthyExpiry] = useState(""); // format YYYY-MM-DD
  const [registrationExpiry, setRegistrationExpiry] = useState("");
  const [verifyStep, setVerifyStep] = useState(1);
  const [showDiditWebView, setShowDiditWebView] = useState(false);
  const [diditSessionUrl, setDiditSessionUrl] = useState<string | null>(null);
  const [startingDiditVerification, setStartingDiditVerification] = useState(false);

  // Location
  const [location, setLocation] = useState<any>(null);
  const [pickupText, setPickupText] = useState("");
  const [dropoffText, setDropoffText] = useState("");
  const [extraStops, setExtraStops] = useState<{ text: string; pin: any; suggestions: any[] }[]>([]);
  const [hireHours, setHireHours] = useState(1);
  const [hireVehicle, setHireVehicle] = useState("car");
  const [hirePickup, setHirePickup] = useState("");
  const [hireSugg, setHireSugg] = useState<any[]>([]);
  const [pushNotifsEnabled, setPushNotifsEnabled] = useState(true);
  const [rideUpdatesEnabled, setRideUpdatesEnabled] = useState(true);
  const [promoNotifsEnabled, setPromoNotifsEnabled] = useState(true);
  const [pickupPin, setPickupPin] = useState<any>(null);
  const [dropoffPin, setDropoffPin] = useState<any>(null);
  const [pickupSugg, setPickupSugg] = useState<any[]>([]);
  const [bookingForSomeoneElse, setBookingForSomeoneElse] = useState(false);
  const [recipientName, setRecipientName] = useState("");
  const [recipientPhone, setRecipientPhone] = useState("");
  const [bookingQuantity, setBookingQuantity] = useState(1);
  const [submittingBulkBooking, setSubmittingBulkBooking] = useState(false);
  const [paymentDescription, setPaymentDescription] = useState("Ride Fare");
  const [showMoreBookingOptions, setShowMoreBookingOptions] = useState(false);
  const [dropoffSugg, setDropoffSugg] = useState<any[]>([]);
  const [searchingPlaces, setSearchingPlaces] = useState(false);
  const [activeField, setActiveField] = useState<string | null>(null);
  const [pinMode, setPinMode] = useState<string | null>(null);
  const [fullMapView, setFullMapView] = useState<{ lat: number | null; lng: number | null; label: string; mode: "driver" | "client" } | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [loadingFullMap, setLoadingFullMap] = useState(false);
  const [liveSelfLocation, setLiveSelfLocation] = useState<any>(null);

  // Booking
  const [selectedService, setSelectedService] = useState("car");
  const [estFare, setEstFare] = useState<number | null>(null);
  const [estKm, setEstKm] = useState<number | null>(null);
  const [paymentMethod, setPaymentMethod] = useState("cash");
  const [scheduleRide, setScheduleRide] = useState(false);
  const [scheduledDay, setScheduledDay] = useState<string | null>(null);
  const [scheduledTime, setScheduledTime] = useState<string | null>(null);
  const [promoCode, setPromoCode] = useState("");
  const [promoApplied, setPromoApplied] = useState<any>(null);
  const [promoError, setPromoError] = useState("");
  const [promoCredit, setPromoCredit] = useState(0);
  const [favouriteDrivers, setFavouriteDrivers] = useState<any[]>([]);
  const [homeAddress, setHomeAddress] = useState<{ text: string; lat: number; lng: number } | null>(null);
  const [homeAddressInput, setHomeAddressInput] = useState("");
  const [homeAddressSugg, setHomeAddressSugg] = useState<any[]>([]);
  const [showPaystack, setShowPaystack] = useState(false);
  const [pendingPaymentBookingId, setPendingPaymentBookingId] = useState<string | null>(null);
  const [clientBookings, setClientBookings] = useState<any[]>([]);
  const [driverBookings, setDriverBookings] = useState<any[]>([]);
  const [activeBookingId, setActiveBookingId] = useState<string | null>(null);
  const [unfinishedRide, setUnfinishedRide] = useState<any>(null);
  const [autoNavigatedBookingId, setAutoNavigatedBookingId] = useState<string | null>(null);
  const [bookingAcceptedAt, setBookingAcceptedAt] = useState<Date | null>(null);
  const [driverArrivedAt, setDriverArrivedAt] = useState<Date | null>(null);
  const [waitingCharge, setWaitingCharge] = useState(0);
  const [waitingTimer, setWaitingTimer] = useState<any>(null);
  const [waitingSecondsElapsed, setWaitingSecondsElapsed] = useState(0);
  const [tripStarted, setTripStarted] = useState(false);

  // Driver
  const [online, setOnline] = useState(false);
  const [incomingRideAlert, setIncomingRideAlert] = useState<any>(null);
  const [seenRideAlertIds, setSeenRideAlertIds] = useState<string[]>([]);
  const [queuedRides, setQueuedRides] = useState<any[]>([]);
  const [driverProfile, setDriverProfile] = useState<any>(null);
  const [driverWallet, setDriverWallet] = useState<any>(null);
  const [showWithdrawModal, setShowWithdrawModal] = useState(false);
  const [withdrawMomoProvider, setWithdrawMomoProvider] = useState("");
  const [withdrawMomoNumber, setWithdrawMomoNumber] = useState("");
  const [processingWithdrawal, setProcessingWithdrawal] = useState(false);
  const [driverRating, setDriverRating] = useState<number>(5.0);
  const [driverLiveLocation, setDriverLiveLocation] = useState<any>(null);
  const [riderLiveLocation, setRiderLiveLocation] = useState<any>(null);
  const [driverEtaMinutes, setDriverEtaMinutes] = useState<number | null>(null);
  const [riderEtaMinutes, setRiderEtaMinutes] = useState<number | null>(null);
  const [assignedDriver, setAssignedDriver] = useState<any>(null);

  // Chat
  const [chatMessages, setChatMessages] = useState<any[]>([]);
  const [chatInput, setChatInput] = useState("");
  const [uploadingChatPhoto, setUploadingChatPhoto] = useState(false);

  // Rating
  const [ratingBookingId, setRatingBookingId] = useState<string | null>(null);
  const [selectedRating, setSelectedRating] = useState(0);
  const [ratingComment, setRatingComment] = useState("");
  const [showRatingModal, setShowRatingModal] = useState(false);
  const [customAlert, setCustomAlert] = useState<{ title: string; message: string; icon: string; iconColor: string; buttons: { text: string; onPress?: () => void; style?: "default" | "cancel" | "destructive" }[] } | null>(null);

  // Drop-in replacement for the native showAlert(title, message, buttons) —
  // same exact call signature, so every existing call site converts with a
  // simple find-replace of the function name, no need to touch each one's
  // internal logic. Auto-picks an icon/color based on keywords in the title,
  // so a mechanical rename still looks intentional rather than generic.
  const showAlert = (title: string, message?: string, buttons?: { text: string; onPress?: () => void; style?: "default" | "cancel" | "destructive" }[]) => {
    const t = title.toLowerCase();
    let icon = "information-circle";
    let iconColor = "#5B8FE0";
    if (/error|failed|couldn.t|missing|invalid|denied|declined|rejected|suspended|expired|limit reached|not found|already/.test(t)) {
      icon = "alert-circle"; iconColor = "#F87171";
    } else if (/success|sent|complete|approved|added|confirmed|paid|requested|updated|saved|delivered|verified/.test(t)) {
      icon = "checkmark-circle"; iconColor = "#2DD4BF";
    } else if (/warning|outstanding|required|pending/.test(t)) {
      icon = "warning"; iconColor = "#F5A623";
    }
    setCustomAlert({
      title,
      message: message || "",
      icon,
      iconColor,
      buttons: buttons && buttons.length > 0 ? buttons : [{ text: "OK" }],
    });
  };
  const [showFoodHistory, setShowFoodHistory] = useState(false);
  const [editName, setEditName] = useState("");
  const [editPhone, setEditPhone] = useState("");
  const [savingProfileEdit, setSavingProfileEdit] = useState(false);
  const [showFoodRatingModal, setShowFoodRatingModal] = useState(false);
  const [pendingFoodRatingOrderId, setPendingFoodRatingOrderId] = useState<string | null>(null);
  const [selectedFoodRating, setSelectedFoodRating] = useState(0);
  const [selectedRiderRating, setSelectedRiderRating] = useState(0);
  const [showTipModal, setShowTipModal] = useState(false);
  const [showTipPaystack, setShowTipPaystack] = useState(false);
  const [tipAmount, setTipAmount] = useState(0);
  const [tipBookingId, setTipBookingId] = useState<string | null>(null);
  const [pendingRatingBookingId, setPendingRatingBookingId] = useState<string | null>(null);

  // SOS
  const [sosActive, setSosActive] = useState(false);
  const [notifications, setNotifications] = useState<any[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [emergencyContacts, setEmergencyContacts] = useState<any[]>([]);
  const [newContactName, setNewContactName] = useState("");
  const [newContactPhone, setNewContactPhone] = useState("");

  // Platform-wide modes (controlled from admin dashboard via system_settings)
  const [maintenanceMode, setMaintenanceMode] = useState(false);
  const [birthdayMode, setBirthdayMode] = useState(false);

  // Refs
  const ptRef = useRef<any>(null);
  const fullMapWebViewRef = useRef<any>(null);
  const [frozenFullMapCoords, setFrozenFullMapCoords] = useState<{ lat: number; lng: number } | null>(null);
  const [chatOpen, setChatOpen] = useState(false);
  const [lastSeenChatMessageId, setLastSeenChatMessageId] = useState<string | null>(null);
  const fullMapWasOpenRef = useRef(false);
  const dtRef = useRef<any>(null);

  // ============================================================
  // PLATFORM SETTINGS — load on app start, then re-check periodically so
  // Maintenance Mode acts like a real kill switch for sessions already open
  // ============================================================
  useEffect(() => {
    const applySettings = () => {
      setMaintenanceMode(PLATFORM_SETTINGS.maintenance_mode_active === 1);
      setBirthdayMode(PLATFORM_SETTINGS.birthday_mode_active === 1);
    };
    loadPlatformSettings().then(applySettings);
    const interval = setInterval(() => {
      loadPlatformSettings().then(applySettings);
    }, 20000); // re-check every 20s
    return () => clearInterval(interval);
  }, []);

  // Poll for new ride requests regardless of which screen a driver is currently
  // on — so a popup can appear even while they're mid-ride, without needing to
  // navigate anywhere to see or accept it.
  useEffect(() => {
    if (!online) { setIncomingRideAlert(null); return; }
    checkForIncomingRideAlert();
    const interval = setInterval(checkForIncomingRideAlert, 6000);
    return () => clearInterval(interval);
  }, [online, user?.role]);

  // ============================================================
  // LOCATION
  // ============================================================
  useEffect(() => {
    (async () => {
      try {
        const { status } = await Location.requestForegroundPermissionsAsync();
        if (status === "granted") {
          const loc = await Location.getCurrentPositionAsync({
            accuracy: Location.Accuracy.Balanced,
          });
          setLocation(loc.coords);
        }
      } catch (e) {
        console.log("Location unavailable — user can still search manually");
      }
    })();
  }, []);

  // Pickup used to auto-fill with current location the instant the booking
  // screen opened — convenient when you ARE the one being picked up, but it
  // actively worked against booking a pickup somewhere else entirely (a
  // school, a relative's house) since it could overwrite what you were
  // typing. Now it stays empty by default; "Use My Current Location" is an
  // explicit, optional action instead of a forced default.

  // ============================================================
  // DATA FETCHING
  // ============================================================
  useEffect(() => {
    if (screen === "clientOrders" || screen === "bookRide") {
      if (screen === "clientOrders" && !online) return; // offline drivers don't poll for rides
      fetchDriverBookings();
      const interval = setInterval(fetchDriverBookings, 8000);
      return () => clearInterval(interval);
    }
  }, [screen, online]);

  useEffect(() => {
    if (screen === "myBookings" || screen === "clientHome" || screen === "trackRide") {
      fetchClientBookings();
      const interval = setInterval(fetchClientBookings, 5000);
      return () => clearInterval(interval);
    }
  }, [screen]);

  useEffect(() => {
    if (screen === "driverEarnings" || screen === "driverHome") {
      fetchWallet();
      fetchDriverRating();
    }
  }, [screen]);

  useEffect(() => {
    if (screen === "driverHome") {
      loadOnlineStatus();
      checkForUnfinishedRide();
    }
  }, [screen]);

  useEffect(() => {
    if (screen === "driverProfile") {
      fetchDriverReferralCode();
    }
  }, [screen]);

  useEffect(() => {
    if (screen === "clientHome") {
      fetchClientProfile();
    }
  }, [screen]);

  useEffect(() => {
    if (screen === "emergencyContacts") {
      fetchEmergencyContacts();
    }
  }, [screen]);

  useEffect(() => {
    if (screen === "restaurantHome" || screen === "menuManagement") {
      fetchMyRestaurant();
    }
  }, [screen]);

  useEffect(() => {
    if (screen === "restaurantIncomingOrders") {
      fetchIncomingFoodOrders();
      const interval = setInterval(fetchIncomingFoodOrders, 8000);
      return () => clearInterval(interval);
    }
  }, [screen, myRestaurant]);

  useEffect(() => {
    if (screen === "foodDelivery") {
      fetchRestaurantList();
    }
  }, [screen]);

  useEffect(() => {
    if (screen === "myFoodOrders") {
      fetchFoodOrders();
      const interval = setInterval(fetchFoodOrders, 5000);
      return () => clearInterval(interval);
    }
  }, [screen]);

  useEffect(() => {
    if (screen === "myLostItems") {
      fetchMyLostItems();
      const interval = setInterval(fetchMyLostItems, 8000);
      return () => clearInterval(interval);
    }
  }, [screen]);

  useEffect(() => {
    if (screen === "myRefundRequests") {
      fetchMyRefundRequests();
      const interval = setInterval(fetchMyRefundRequests, 8000);
      return () => clearInterval(interval);
    }
  }, [screen]);

  useEffect(() => {
    if (screen === "driverLostItems") {
      fetchDriverLostItemReports();
      const interval = setInterval(fetchDriverLostItemReports, 8000);
      return () => clearInterval(interval);
    }
  }, [screen]);

  useEffect(() => {
    if (screen === "availableFoodDeliveries") {
      if (!online) return; // offline riders don't see available deliveries
      fetchAvailableFoodDeliveries();
      const interval = setInterval(fetchAvailableFoodDeliveries, 8000);
      return () => clearInterval(interval);
    }
  }, [screen, online]);

  useEffect(() => {
    if (screen === "clientHome" || screen === "driverHome" || screen === "notifications") {
      fetchNotifications();
      const interval = setInterval(fetchNotifications, 15000);
      return () => clearInterval(interval);
    }
  }, [screen]);

  const fetchDriverBookings = async () => {
    const { data: { user: u } } = await supabase.auth.getUser();
    const serviceMap: { [key: string]: string } = { car_driver: "car", tuktuk_driver: "tuktuk", motorbike_rider: "motorbike" };
    const myService = user?.role ? serviceMap[user.role] : undefined;

    // Two scoped queries instead of one unfiltered pull of the entire table:
    // (a) MY OWN bookings — any status — for ride history, stats, and
    //     resuming an active ride. This alone used to be the bug: without it,
    //     ANY driver could see EVERY booking ever made by EVERY driver and
    //     client on the platform, including completed rides that weren't
    //     theirs — exactly what was reported.
    // (b) Unassigned PENDING requests matching this driver's own vehicle
    //     type — the actual "new ride requests to consider accepting" list.
    const ownBookingsPromise = u
      ? supabase.from("bookings").select("*").eq("driver_id", u.id).order("created_at", { ascending: false })
      : Promise.resolve({ data: [] });
    const pendingRequestsPromise = myService
      ? supabase.from("bookings").select("*").eq("status", "pending").eq("service", myService).is("driver_id", null).order("created_at", { ascending: false })
      : Promise.resolve({ data: [] });

    const [{ data: ownBookings }, { data: pendingRequests }] = await Promise.all([ownBookingsPromise, pendingRequestsPromise]);

    // Merge and de-duplicate by id (a booking could theoretically appear in
    // both sets in a race, e.g. this driver's own request that's somehow
    // also unassigned — shouldn't normally happen, but de-duping is cheap insurance).
    const merged = [...(ownBookings || []), ...(pendingRequests || [])];
    const deduped = Array.from(new Map(merged.map(b => [b.id, b])).values());
    setDriverBookings(deduped);
  };

  // Load the driver's saved online/offline availability from their profile
  const loadOnlineStatus = async () => {
    const { data: { user: u } } = await supabase.auth.getUser();
    if (!u) return;
    const { data } = await supabase.from("profiles").select("is_online, notif_push, notif_rides, notif_promos").eq("id", u.id).maybeSingle();
    if (data) {
      if (typeof data.is_online === "boolean") setOnline(data.is_online);
      if (typeof data.notif_push === "boolean") setPushNotifsEnabled(data.notif_push);
      if (typeof data.notif_rides === "boolean") setRideUpdatesEnabled(data.notif_rides);
      if (typeof data.notif_promos === "boolean") setPromoNotifsEnabled(data.notif_promos);
    }
  };

  // Persist a single notification preference, updating UI immediately
  const saveNotifPref = async (column: string, value: boolean, setter: (v: boolean) => void) => {
    setter(value);
    const { data: { user: u } } = await supabase.auth.getUser();
    if (!u) return; // demo accounts: UI-only
    await supabase.from("profiles").update({ [column]: value }).eq("id", u.id);
  };

  // Toggle availability and persist it — offline drivers stop receiving new ride requests
  const toggleOnline = async (value: boolean) => {
    if (value) {
      // Going online requires being fully verified — identity for everyone,
      // PLUS license approval for car drivers, but ONLY those who went
      // through the NEW Didit flow (didit_status is set). Drivers approved
      // under the OLD system — before Didit or this separate license check
      // existed — already had their license reviewed as part of that single
      // approval; retroactively blocking them over a field that didn't exist
      // yet when they were approved isn't fair and isn't the intent here.
      const { data: { user: checkUser } } = await supabase.auth.getUser();
      if (checkUser) {
        const { data: freshProfile } = await supabase.from("profiles").select("is_verified, license_verified, didit_status, role").eq("id", checkUser.id).maybeSingle();
        if (!freshProfile?.is_verified) {
          showAlert("Verification required", "You need to complete identity verification before going online.");
          return;
        }
        if (freshProfile.role === "car_driver" && freshProfile.didit_status && !freshProfile.license_verified) {
          showAlert("License review pending", "Your driver's license is still awaiting review — you'll be notified once it's approved.");
          return;
        }
      }
    }
    setOnline(value); // update UI immediately
    const { data: { user: u } } = await supabase.auth.getUser();
    if (!u) return; // demo accounts have no real profile row; UI-only is fine for them
    const { error } = await supabase.from("profiles").update({ is_online: value }).eq("id", u.id);
    if (error) {
      // Roll back if the save failed
      setOnline(!value);
      showAlert("Couldn't update status", "Please check your connection and try again.");
    }
  };

  const fetchWallet = async () => {
    const { data: { user: u } } = await supabase.auth.getUser();
    const driverId = u?.id || "00000000-0000-0000-0000-000000000002";
    const { data } = await supabase
      .from("wallets")
      .select("*")
      .eq("user_id", driverId)
      .maybeSingle();
    setDriverWallet(data || { balance: 0, total_earned: 0, total_withdrawn: 0, currency: "GHS" });
  };

  const fetchDriverRating = async () => {
    const { data: { user: u } } = await supabase.auth.getUser();
    const driverId = u?.id || "00000000-0000-0000-0000-000000000002";
    const { data } = await supabase
      .from("reviews")
      .select("rating")
      .eq("pro_id", driverId);
    if (data && data.length > 0) {
      const avg = data.reduce((s: number, r: any) => s + r.rating, 0) / data.length;
      setDriverRating(parseFloat(avg.toFixed(1)));
    }
  };

  const fetchClientProfile = async () => {
    const { data: { user: u } } = await supabase.auth.getUser();
    if (!u) return;
    const { data: profile } = await supabase
      .from("profiles")
      .select("promo_credit, referral_code, full_name, home_address, home_address_lat, home_address_lng")
      .eq("id", u.id)
      .maybeSingle();
    if (profile) {
      setPromoCredit(profile.promo_credit || 0);
      setUser((prev: any) => ({ ...prev, referralCode: profile.referral_code, name: profile.full_name }));
      if (profile.home_address) {
        setHomeAddress({
          text: profile.home_address,
          lat: profile.home_address_lat,
          lng: profile.home_address_lng,
        });
      }
    }
    fetchFavouriteDrivers();
  };

  // Saves the client's home address for reuse as a one-tap dropoff suggestion
  const saveHomeAddress = async (text: string, lat: number, lng: number) => {
    const { data: { user: u } } = await supabase.auth.getUser();
    if (!u) {
      showAlert("Sign in required", "Please log in with a real account to save a home address.");
      return;
    }
    const { error } = await supabase.from("profiles").update({
      home_address: text,
      home_address_lat: lat,
      home_address_lng: lng,
    }).eq("id", u.id);
    if (error) { showAlert("Error", "Could not save your home address: " + error.message); return; }
    setHomeAddress({ text, lat, lng });
    showAlert("Saved! 🏠", "Your home address will now show as a quick option when booking.");
  };

  const removeHomeAddress = async () => {
    const { data: { user: u } } = await supabase.auth.getUser();
    if (u) await supabase.from("profiles").update({ home_address: null, home_address_lat: null, home_address_lng: null }).eq("id", u.id);
    setHomeAddress(null);
  };

  const fetchDriverReferralCode = async () => {
    const { data: { user: u } } = await supabase.auth.getUser();
    if (!u) return; // demo accounts already have a hardcoded referralCode set at login
    const { data: profile } = await supabase
      .from("profiles")
      .select("referral_code, full_name")
      .eq("id", u.id)
      .maybeSingle();
    if (profile) {
      if (profile.referral_code) {
        setUser((prev: any) => ({ ...prev, referralCode: profile.referral_code }));
      } else {
        // Older account created before referral codes existed — generate one now
        const newCode = await generateReferralCode(profile.full_name || "DRIVER");
        await supabase.from("profiles").update({ referral_code: newCode }).eq("id", u.id);
        setUser((prev: any) => ({ ...prev, referralCode: newCode }));
      }
    }
  };

  // ============================================================
  // FAVOURITE DRIVERS — Blueprint: max 5 per client
  // ============================================================
  const fetchFavouriteDrivers = async () => {
    const { data: { user: u } } = await supabase.auth.getUser();
    const clientId = u?.id || "00000000-0000-0000-0000-000000000001";
    const { data } = await supabase
      .from("favourite_drivers")
      .select("*")
      .eq("client_id", clientId)
      .order("created_at", { ascending: false });
    if (data) setFavouriteDrivers(data);
  };

  const addFavouriteDriver = async (driverId: string, driverName: string) => {
    if (favouriteDrivers.length >= 5) {
      showAlert("Limit Reached", "You can have a maximum of 5 favourite drivers. Remove one first to add a new one.");
      return;
    }
    if (favouriteDrivers.some(f => f.driver_id === driverId)) {
      showAlert("Already Added", `${driverName} is already in your favourites.`);
      return;
    }
    const { data: { user: u } } = await supabase.auth.getUser();
    if (!u) {
      showAlert("Sign in required", "Favourite drivers can only be saved on a real account. Demo accounts can't add favourites.");
      return;
    }
    const clientId = u.id;
    const { error } = await supabase.from("favourite_drivers").insert({
      client_id: clientId,
      driver_id: driverId,
      driver_name: driverName,
    });
    if (!error) {
      haptic("success");
      showAlert("Added! ⭐", `${driverName} is now one of your favourite drivers.`);
      fetchFavouriteDrivers();
    } else {
      // Surface the real reason instead of failing silently — this is almost
      // always a Row Level Security policy on favourite_drivers blocking the
      // insert, and showing the actual error is what makes that diagnosable.
      showAlert("Couldn't add favourite", error.message);
    }
  };

  const removeFavouriteDriver = async (favId: string, driverName: string) => {
    await supabase.from("favourite_drivers").delete().eq("id", favId);
    showAlert("Removed", `${driverName} removed from favourites.`);
    fetchFavouriteDrivers();
  };

  const fetchClientBookings = async () => {
    const { data: { user: u } } = await supabase.auth.getUser();
    const clientId = u?.id || "00000000-0000-0000-0000-000000000001";
    const { data } = await supabase
      .from("bookings")
      .select("*")
      .eq("client_id", clientId)
      .order("created_at", { ascending: false });
    if (data) {
      setClientBookings(data);

      // Only bookings from the last 2 hours can trigger auto-navigation/auto-payment/
      // auto-rating below — without this, an old stale booking (e.g. leftover test data)
      // would re-trigger these every single time the app restarts, since the "already
      // handled" guards below are just in-memory state that resets on restart.
      const isRecent = (dateStr: string) => Date.now() - new Date(dateStr).getTime() < 2 * 60 * 60 * 1000;

      // Auto-navigate straight to live tracking the moment a driver accepts —
      // works from clientHome or myBookings, no manual button needed
      if (screen === "clientHome" || screen === "myBookings") {
        const justAccepted = data.find((b: any) => b.status === "accepted" && isRecent(b.created_at));
        if (justAccepted && autoNavigatedBookingId !== justAccepted.id) {
          setAutoNavigatedBookingId(justAccepted.id);
          setActiveBookingId(justAccepted.id);
          go("trackRide");
          return;
        }
      }

      if (screen === "myBookings" || screen === "trackRide") {
        // Auto-trigger payment for completed MoMo/Card rides
        const needsPayment = data.find((b: any) =>
          b.status === "completed" &&
          b.payment_method !== "cash" &&
          b.payment_status !== "paid" &&
          isRecent(b.created_at) &&
          !showPaystack
        );
        if (needsPayment && pendingPaymentBookingId !== needsPayment.id) {
          triggerPaymentForBooking(needsPayment);
          return;
        }

        // Auto-trigger payment for outstanding cancellation fees (e.g. the client
        // dismissed the popup earlier, or a no-show auto-cancel happened on the
        // driver's device while this client wasn't in the app)
        const needsCancellationFeePayment = data.find((b: any) =>
          b.status === "cancelled" &&
          (b.cancellation_charge || 0) > 0 &&
          b.payment_status !== "paid" &&
          isRecent(b.created_at) &&
          !showPaystack
        );
        if (needsCancellationFeePayment && pendingPaymentBookingId !== needsCancellationFeePayment.id) {
          triggerCancellationFeePayment(needsCancellationFeePayment);
          return;
        }

        // Auto-trigger rating modal for completed unrated rides
        const needsRating = data.find((b: any) =>
          b.status === "completed" &&
          !b.rated &&
          isRecent(b.created_at) &&
          !showRatingModal
        );
        if (needsRating && pendingRatingBookingId !== needsRating.id) {
          openRatingModal(needsRating.id);
        }
      }
    }
  };

  const fetchMessages = async (bookingId: string) => {
    const { data } = await supabase
      .from("messages")
      .select("*")
      .eq("booking_id", bookingId)
      .order("created_at", { ascending: true });
    if (data) setChatMessages(data);
  };

  const fetchDriverLocation = async (bookingId: string) => {
    const { data } = await supabase
      .from("bookings")
      .select("driver_lat,driver_lng,client_lat,client_lng")
      .eq("id", bookingId)
      .single();
    if (data?.driver_lat) {
      setDriverLiveLocation({ latitude: data.driver_lat, longitude: data.driver_lng });
      if (data.client_lat && data.client_lng) {
        // Straight-line distance/speed guess as an immediate fallback — gets
        // replaced by the real routed ETA below the moment it resolves, and
        // stays as the answer if that request ever fails (offline moment,
        // OSRM demo server briefly busy).
        const km = getDist(data.driver_lat, data.driver_lng, data.client_lat, data.client_lng);
        setDriverEtaMinutes(Math.max(1, Math.round((km / 22) * 60)));
        fetchRealETA(data.driver_lat, data.driver_lng, data.client_lat, data.client_lng, setDriverEtaMinutes);
      }
    }
  };

  // Real road-routing ETA via OSRM (same free service used for the map
  // routes) — accounts for actual streets, turns, and one-ways, instead of
  // a straight-line guess through buildings.
  const fetchRealETA = async (fromLat: number, fromLng: number, toLat: number, toLng: number, setter: (m: number) => void) => {
    try {
      const res = await fetch(`https://router.project-osrm.org/route/v1/driving/${fromLng},${fromLat};${toLng},${toLat}?overview=false`);
      const data = await res.json();
      const durationSeconds = data?.routes?.[0]?.duration;
      if (durationSeconds != null) {
        setter(Math.max(1, Math.round(durationSeconds / 60)));
      }
    } catch (e) {
      // Silent — the straight-line estimate set just before this call remains
      // on screen, which is still useful even if slightly less accurate.
    }
  };

  const fetchRiderLocation = async (orderId: string) => {
    const { data } = await supabase
      .from("food_orders")
      .select("rider_lat,rider_lng,delivery_lat,delivery_lng")
      .eq("id", orderId)
      .maybeSingle();
    if (data?.rider_lat) {
      setRiderLiveLocation({ latitude: data.rider_lat, longitude: data.rider_lng });
      if (data.delivery_lat && data.delivery_lng) {
        const km = getDist(data.rider_lat, data.rider_lng, data.delivery_lat, data.delivery_lng);
        setRiderEtaMinutes(Math.max(1, Math.round((km / 28) * 60)));
        fetchRealETA(data.rider_lat, data.rider_lng, data.delivery_lat, data.delivery_lng, setRiderEtaMinutes);
      }
    }
  };

  // Fetch the assigned driver's profile (name, rating, vehicle) for the tracking screen
  const fetchAssignedDriver = async (bookingId: string) => {
    const { data: booking } = await supabase.from("bookings").select("driver_id").eq("id", bookingId).maybeSingle();
    if (!booking?.driver_id) { setAssignedDriver(null); return; }
    const { data: profile } = await supabase
      .from("profiles")
      .select("full_name, average_rating, vehicle_make, vehicle_model, vehicle_plate, vehicle_color, vehicle_photo_url, profile_photo, phone, role")
      .eq("id", booking.driver_id)
      .maybeSingle();
    if (profile) setAssignedDriver(profile);
  };

  // Client polls driver location every 3 seconds while tracking
  useEffect(() => {
    if (screen === "trackRide" && activeBookingId) {
      // Clear any previous ride's data immediately so nothing stale flashes
      // on screen while the fresh data for THIS booking is still loading
      setAssignedDriver(null);
      setDriverLiveLocation(null);
      setChatMessages([]);

      fetchDriverLocation(activeBookingId);
      fetchMessages(activeBookingId);
      fetchAssignedDriver(activeBookingId);
      const interval = setInterval(() => {
        fetchDriverLocation(activeBookingId);
        fetchMessages(activeBookingId);
      }, 3000);
      return () => clearInterval(interval);
    }
  }, [screen, activeBookingId]);

  useEffect(() => {
    if (screen === "foodOrderTracking" && activeFoodOrderId) {
      setRiderLiveLocation(null);
      fetchRiderLocation(activeFoodOrderId);
      const interval = setInterval(() => fetchRiderLocation(activeFoodOrderId), 3000);
      return () => clearInterval(interval);
    }
  }, [screen, activeFoodOrderId]);

  // Driver polls messages every 3 seconds during an active ride (keeps chat live both ways)
  useEffect(() => {
    if (screen === "activeRide" && activeBookingId) {
      fetchMessages(activeBookingId);
      const interval = setInterval(() => fetchMessages(activeBookingId), 3000);
      return () => clearInterval(interval);
    }
  }, [screen, activeBookingId]);

  // ============================================================
  // AUTH
  // ============================================================
  const doLogin = async () => {
    if (!authEmail || !authPass) { showAlert("Error", "Please enter email and password"); return; }
    // Demo accounts
    if (authEmail === "driver@demo.com") {
      const demoDriverId = "00000000-0000-0000-0000-000000000002";
      setUser({ name: "Demo Driver", email: authEmail, role: "driver", verified: true, phone: "+233 55 000 0001", referralCode: "DEMO-DR1V" });
      go("driverHome");
      // Fire-and-forget push registration — doesn't block navigation or affect demo login if it fails
      registerForPushNotifications().then(async (token) => {
        if (token) {
          await supabase.from("profiles").upsert({ id: demoDriverId, full_name: "Demo Driver", role: "driver", push_token: token });
        }
      }).catch(() => {});
      return;
    }
    if (authEmail === "client@demo.com") {
      const demoClientId = "00000000-0000-0000-0000-000000000001";
      setUser({ name: "Demo Client", email: authEmail, role: "client", verified: true, phone: "+233 55 000 0002", referralCode: "DEMO-CL1T" });
      go("clientHome");
      registerForPushNotifications().then(async (token) => {
        if (token) {
          await supabase.from("profiles").upsert({ id: demoClientId, full_name: "Demo Client", role: "client", push_token: token });
        }
      }).catch(() => {});
      return;
    }
    const { data, error } = await supabase.auth.signInWithPassword({ email: authEmail, password: authPass });
    if (error) {
      if (error.message.toLowerCase().includes("email not confirmed")) {
        go("confirmEmail");
        return;
      }
      showAlert("Error", error.message);
      return;
    }
    let { data: profile } = await supabase.from("profiles").select("*").eq("id", data.user?.id).maybeSingle();

    // Self-heal: if this account is confirmed but somehow has no profile row (e.g. an
    // earlier signup attempt that got interrupted before this was fixed), rebuild it now
    // from the metadata saved at signup time, instead of leaving the account stuck forever.
    if (!profile) {
      const meta = data.user?.user_metadata || {};
      if (meta.full_name) {
        const refCode = await generateReferralCode(meta.full_name);
        const { data: healedProfile, error: healError } = await supabase.from("profiles").insert({
          id: data.user?.id,
          full_name: meta.full_name,
          email: authEmail,
          phone: meta.phone_number || null,
          role: meta.role || "client",
          is_verified: (meta.role || "client") === "client",
          referral_code: refCode,
          promo_credit: 0,
          welcome_discount_used: false,
          first_ride_done: false,
        }).select().single();
        if (!healError) profile = healedProfile;
      }
    }

    if (!profile) {
      showAlert("Account Issue", "We couldn't find your profile details. Please try signing up again with this email, or contact support.");
      return;
    }
    const role = profile.role || profile.account_type || "client";
    const u = { name: profile.full_name, email: profile.email, phone: profile.phone, role, verified: profile.is_verified, suspended: profile.suspended, referralCode: profile.referral_code, profilePhoto: profile.profile_photo };
    setUser(u);

    // Register for push notifications and save token
    registerForPushNotifications().then(async (token) => {
      if (token) await supabase.from("profiles").update({ push_token: token }).eq("id", data.user?.id);
    });

    const isDriver = ["car_driver", "tuktuk_driver", "motorbike_rider", "restaurant", "driver", "home_service"].includes(role);
    if (!isDriver) { go("clientHome"); }
    else {
      if (u.suspended) {
        showAlert("Account Suspended", "Your account has been suspended. Please contact support.");
        return;
      }
      if (u.verified) { go(role === "restaurant" ? "restaurantHome" : "driverHome"); }
      else if (profile.kyc_submitted) { go("pending"); }
      else { setAuthRole(role); setVerifyStep(1); go("verify"); }
    }
  };

  const doSignup = async () => {
    if (!authName || !authEmail || !authPass) { showAlert("Error", "Please fill all fields"); return; }
    if (authPass !== authConfirm) { showAlert("Error", "Passwords do not match"); return; }
    const { data, error } = await supabase.auth.signUp({
      email: authEmail,
      password: authPass,
      options: {
        data: {
          full_name: authName,
          phone: authPhone,
          role: authRole,
          driver_ref_code: driverRefCode.trim() || null,
        },
      },
    });
    if (error) { showAlert("Error", error.message); return; }

    const isDriverRole = ["car_driver", "tuktuk_driver", "motorbike_rider", "restaurant", "home_service"].includes(authRole || "");

    // If Supabase requires email confirmation, there is NO active session yet at this point —
    // RLS would silently reject a profile insert here (auth.uid() is null). Defer profile
    // creation to verifyEmailCode(), which runs after the user actually confirms and has
    // a real, valid session.
    if (!data.session) {
      go("confirmEmail");
      return;
    }

    // A session exists immediately (confirmation not required) — safe to create the profile now
    const refCode = await generateReferralCode(authName);
    let referredByDriverId: string | null = null;
    if (isDriverRole && driverRefCode.trim()) {
      const { data: referrerDriver } = await supabase
        .from("profiles")
        .select("id")
        .eq("referral_code", driverRefCode.trim().toUpperCase())
        .maybeSingle();
      if (referrerDriver) referredByDriverId = referrerDriver.id;
    }

    const { error: insertError } = await supabase.from("profiles").insert({
      id: data.user?.id,
      full_name: authName,
      email: authEmail,
      phone: authPhone,
      role: authRole,
      is_verified: authRole === "client",
      referral_code: refCode,
      referred_by: referredByDriverId,
      promo_credit: 0,
      welcome_discount_used: false,
      first_ride_done: false,
    });
    if (insertError) {
      showAlert("Error", "Could not create your profile: " + insertError.message);
      return;
    }

    setUser({ name: authName, email: authEmail, phone: authPhone, role: authRole, verified: authRole === "client" });

    // Register for push notifications and save token
    registerForPushNotifications().then(async (token) => {
      if (token) await supabase.from("profiles").update({ push_token: token }).eq("id", data.user?.id);
    });

    if (!isDriverRole) { go("clientHome"); }
    else { setVerifyStep(1); go("verify"); }
  };

  const verifyEmailCode = async () => {
    const code = emailOtpCode.trim();
    if (!code || code.length < 6) {
      showAlert("Enter Code", "Please enter the code from your email.");
      return;
    }
    setVerifyingCode(true);
    const { data, error } = await supabase.auth.verifyOtp({
      email: authEmail,
      token: code,
      type: "signup",
    });
    if (error) {
      setVerifyingCode(false);
      showAlert("Invalid Code", error.message);
      return;
    }
    setEmailOtpCode("");

    // Now we have a REAL authenticated session — check if the profile exists yet.
    let { data: profile } = await supabase.from("profiles").select("*").eq("id", data.user?.id).maybeSingle();

    // Prefer the metadata saved on the auth user at signup time — it survives even if
    // the app was closed/reopened while waiting for the email, unlike local form state.
    const meta = data.user?.user_metadata || {};
    const metaName = meta.full_name || authName;
    const metaPhone = meta.phone_number || authPhone;
    const metaRole = meta.role || authRole;
    const metaDriverRefCode = meta.driver_ref_code || driverRefCode;

    if (!profile && metaName) {
      // Fresh signup completing confirmation for the first time — create the profile now
      // that we actually have a valid session (this couldn't be done earlier; see doSignup).
      const refCode = await generateReferralCode(metaName);
      const isDriverRoleNow = ["car_driver", "tuktuk_driver", "motorbike_rider", "restaurant", "home_service"].includes(metaRole || "");
      let referredByDriverId: string | null = null;
      if (isDriverRoleNow && metaDriverRefCode && metaDriverRefCode.trim()) {
        const { data: referrerDriver } = await supabase
          .from("profiles")
          .select("id")
          .eq("referral_code", metaDriverRefCode.trim().toUpperCase())
          .maybeSingle();
        if (referrerDriver) referredByDriverId = referrerDriver.id;
      }
      const { data: newProfile, error: insertError } = await supabase.from("profiles").insert({
        id: data.user?.id,
        full_name: metaName,
        email: authEmail,
        phone: metaPhone,
        role: metaRole,
        is_verified: metaRole === "client",
        referral_code: refCode,
        referred_by: referredByDriverId,
        promo_credit: 0,
        welcome_discount_used: false,
        first_ride_done: false,
      }).select().single();

      if (insertError) {
        setVerifyingCode(false);
        showAlert("Error", "Could not create your profile: " + insertError.message);
        return;
      }
      profile = newProfile;
    }

    if (!profile) {
      setVerifyingCode(false);
      showAlert("Almost there", "Email confirmed! Please log in to continue.");
      setAuthMode("login"); go("auth");
      return;
    }
    const role = profile.role || profile.account_type || "client";
    const u = { name: profile.full_name, email: profile.email, phone: profile.phone, role, verified: profile.is_verified, suspended: profile.suspended, referralCode: profile.referral_code, profilePhoto: profile.profile_photo };
    setUser(u);

    registerForPushNotifications().then(async (token) => {
      if (token) await supabase.from("profiles").update({ push_token: token }).eq("id", data.user?.id);
    });

    setVerifyingCode(false);
    const isDriver = ["car_driver", "tuktuk_driver", "motorbike_rider", "restaurant", "driver", "home_service"].includes(role);
    if (!isDriver) { go("clientHome"); }
    else {
      if (u.suspended) { showAlert("Account Suspended", "Your account has been suspended. Please contact support."); return; }
      if (u.verified) { go(role === "restaurant" ? "restaurantHome" : "driverHome"); }
      else if (profile.kyc_submitted) { go("pending"); }
      else { setAuthRole(role); setVerifyStep(1); go("verify"); }
    }
  };

  const logout = async () => {
    // Mark driver offline so they don't appear available after leaving
    const { data: { user: u } } = await supabase.auth.getUser();
    if (u && online) {
      await supabase.from("profiles").update({ is_online: false }).eq("id", u.id);
    }
    setOnline(false);
    supabase.auth.signOut();
    setUser(null); setAuthEmail(""); setAuthPass(""); setAuthName("");
    go("welcome");
  };

  // ============================================================
  // BOOKING
  // ============================================================
  const pickupChange = (t: string) => {
    setPickupText(t); setActiveField("pickup");
    clearTimeout(ptRef.current);
    if (t.length >= 3) setSearchingPlaces(true);
    ptRef.current = setTimeout(async () => {
      const res = await searchPlaces(t);
      setPickupSugg(res); setSearchingPlaces(false);
    }, 350);
  };

  const dropoffChange = (t: string) => {
    setDropoffText(t); setActiveField("dropoff");
    clearTimeout(dtRef.current);
    if (t.length >= 3) setSearchingPlaces(true);
    dtRef.current = setTimeout(async () => {
      const res = await searchPlaces(t);
      setDropoffSugg(res); setSearchingPlaces(false);
    }, 350);
  };

  const updateFare = (pLat: number, pLon: number, dLat: number, dLon: number) => {
    const km = getDist(pLat, pLon, dLat, dLon);
    setEstKm(parseFloat(km.toFixed(2)));
    const { fare } = calcFare(km, selectedService, driverBookings.filter(b => b.status === "pending").length);
    setEstFare(fare);
  };

  const selPickup = (p: any) => {
    setPickupText(p.name); setPickupPin({ latitude: p.lat, longitude: p.lon });
    setPickupSugg([]); setActiveField(null);
    if (dropoffPin) {
      if (extraStops.some(s => s.pin)) recalcMultiStopFare({ latitude: p.lat, longitude: p.lon }, dropoffPin);
      else updateFare(p.lat, p.lon, dropoffPin.latitude, dropoffPin.longitude);
    }
  };

  const selDropoff = (p: any) => {
    setDropoffText(p.name); setDropoffPin({ latitude: p.lat, longitude: p.lon });
    setDropoffSugg([]); setActiveField(null);
    if (pickupPin) {
      if (extraStops.some(s => s.pin)) recalcMultiStopFare(pickupPin, { latitude: p.lat, longitude: p.lon });
      else updateFare(pickupPin.latitude, pickupPin.longitude, p.lat, p.lon);
    }
  };

  // ============================================================
  // MULTIPLE STOPS — Blueprint: max 3 stops per ride
  // ============================================================
  // ============================================================
  // HOURLY VEHICLE HIRE — Blueprint: Car GHS 110/hr, TukTuk GHS 65/hr, Moto GHS 45/hr
  // Payment AFTER hire period ends — never before
  // ============================================================
  const getHireRate = (vehicle: string) => {
    if (vehicle === "tuktuk") return 115;
    if (vehicle === "motorbike") return 80;
    return 180;
  };

  const [submittingHire, setSubmittingHire] = useState(false);
  const submitHire = async () => {
    if (submittingHire) return;
    setSubmittingHire(true);
    try {
    if (!hirePickup) { showAlert("Missing", "Please enter your pickup location"); return; }

    // Same enforcement as regular ride booking — block until any unpaid
    // cancellation fee is cleared.
    const { data: { user: uCheck } } = await supabase.auth.getUser();
    const clientIdCheck = uCheck?.id || "00000000-0000-0000-0000-000000000001";
    const { data: unpaidFees } = await supabase
      .from("bookings")
      .select("id, cancellation_charge")
      .eq("client_id", clientIdCheck)
      .eq("status", "cancelled")
      .gt("cancellation_charge", 0)
      .neq("payment_status", "paid");
    if (unpaidFees && unpaidFees.length > 0) {
      const totalOwed = unpaidFees.reduce((sum: number, b: any) => sum + (b.cancellation_charge || 0), 0);
      showAlert(
        "Outstanding Fee",
        `You have GHS ${totalOwed.toFixed(2)} in unpaid cancellation fees. Please clear this before booking hourly hire.`,
        [
          { text: "Not Now", style: "cancel" },
          { text: "Pay Now", onPress: () => triggerCancellationFeePayment({ ...unpaidFees[0], payment_method: "card" }) },
        ]
      );
      return;
    }

    const rate = getHireRate(hireVehicle);
    const total = rate * hireHours;
    const vehicleLabel = hireVehicle === "tuktuk" ? "Tuk Tuk" : hireVehicle === "motorbike" ? "Motorbike" : "Car";
    showAlert(
      "Confirm Hourly Hire",
      `${vehicleLabel} for ${hireHours} hour${hireHours > 1 ? "s" : ""}\nRate: GHS ${rate}/hour\nTotal: GHS ${total}\n\nPayment is made AFTER the hire period ends — never before.`,
      [
        { text: "Cancel", style: "cancel" },
        { text: "Confirm Hire", onPress: async () => {
          const { data: { user: u } } = await supabase.auth.getUser();
          const clientId = u?.id || "00000000-0000-0000-0000-000000000001";
          const { data } = await supabase.from("bookings").insert({
            client_id: clientId,
            client_name: authName || user?.name,
            pickup: hirePickup,
            dropoff: `HOURLY HIRE — ${hireHours}hr ${vehicleLabel}`,
            service: hireVehicle,
            price: total,
            status: "pending",
            payment_method: paymentMethod,
            payment_status: paymentMethod === "cash" ? "n/a" : "awaiting_completion",
          }).select().single();
          if (data) {
            notifyOnlineDrivers(hirePickup, hireVehicle, total);
            showAlert("Hire Booked! 🚗", `Your ${vehicleLabel} hire for ${hireHours} hour${hireHours > 1 ? "s" : ""} is confirmed. A driver will be assigned shortly.`, [{ text: "OK", onPress: () => go("myBookings") }]);
            setHirePickup(""); setHireHours(1); setHireVehicle("car");
            fetchClientBookings();
          }
        }},
      ]
    );
    } finally {
      setSubmittingHire(false);
    }
  };

  const addStop = () => {
    if (extraStops.length >= 2) {
      showAlert("Maximum Stops", "You can add up to 3 stops total (dropoff + 2 extra stops).");
      return;
    }
    setExtraStops(prev => [...prev, { text: "", pin: null, suggestions: [] }]);
  };

  const removeStop = (index: number) => {
    setExtraStops(prev => prev.filter((_, i) => i !== index));
  };

  const stopTextChange = (index: number, text: string) => {
    setExtraStops(prev => prev.map((s, i) => i === index ? { ...s, text } : s));
    clearTimeout(ptRef.current);
    ptRef.current = setTimeout(async () => {
      const results = await searchPlaces(text);
      setExtraStops(prev => prev.map((s, i) => i === index ? { ...s, suggestions: results } : s));
    }, 600);
  };

  const selStop = (index: number, p: any) => {
    setExtraStops(prev => prev.map((s, i) => i === index
      ? { text: p.name, pin: { latitude: p.lat, longitude: p.lon }, suggestions: [] }
      : s));
  };

  // Recalculate fare across the full route: pickup -> dropoff -> stop1 -> stop2.
  // Accepts optional override coordinates so a just-picked pickup/dropoff can be
  // used immediately, rather than reading stale state before React re-renders.
  const recalcMultiStopFare = (
    overridePickup?: { latitude: number; longitude: number },
    overrideDropoff?: { latitude: number; longitude: number }
  ) => {
    const p = overridePickup || pickupPin;
    const d = overrideDropoff || dropoffPin;
    if (!p || !d) return;
    let totalKm = getDist(p.latitude, p.longitude, d.latitude, d.longitude);
    let lastPoint = d;
    for (const stop of extraStops) {
      if (stop.pin) {
        totalKm += getDist(lastPoint.latitude, lastPoint.longitude, stop.pin.latitude, stop.pin.longitude);
        lastPoint = stop.pin;
      }
    }
    setEstKm(parseFloat(totalKm.toFixed(2)));
    const { fare } = calcFare(totalKm, selectedService, driverBookings.filter(b => b.status === "pending").length);
    setEstFare(fare);
  };

  // Recalc fare whenever a stop is added/removed OR an existing stop's actual
  // coordinates change (e.g. picking a different place for the same stop slot) —
  // keyed on the real lat/lng, not just whether a pin exists, so swapping one
  // location for another always triggers a fresh calculation.
  const stopsFareKey = extraStops.map(s => s.pin ? `${s.pin.latitude},${s.pin.longitude}` : "0").join("|");
  useEffect(() => {
    if (extraStops.some(s => s.pin)) recalcMultiStopFare();
  }, [stopsFareKey]);

  const saveBookingToSupabase = async (pickup: string, dropoff: string, service: string, price: number, paymentMethodForBooking: string, originalPrice?: number, promoType?: string | null) => {
    const { data: { user: u } } = await supabase.auth.getUser();
    const clientId = u?.id || "00000000-0000-0000-0000-000000000001";
    const scheduledFor = scheduleRide && scheduledDay && scheduledTime
      ? new Date(`${scheduledDay}T${scheduledTime}:00`).toISOString()
      : null;
    const stopsText = extraStops.filter(s => s.text).map(s => s.text).join(" → ");
    const { data } = await supabase.from("bookings").insert({
      client_id: clientId,
      client_name: authName || user?.name,
      pickup,
      dropoff: stopsText ? `${dropoff} → ${stopsText}` : dropoff,
      service,
      price,
      original_price: originalPrice ?? price,
      promo_type: promoType ?? null,
      status: scheduledFor ? "scheduled" : "pending",
      scheduled_for: scheduledFor,
      payment_method: paymentMethodForBooking,
      payment_status: paymentMethodForBooking === "cash" ? "n/a" : "awaiting_completion",
      // Actually saving these now — they were previously only ever READ
      // (for the driver-en-route ETA), never written, meaning the ETA check
      // always silently found nothing and never ran at all, regardless of
      // how good the ETA calculation itself was.
      client_lat: pickupPin?.latitude ?? null,
      client_lng: pickupPin?.longitude ?? null,
      // Booking-for-someone-else: the driver needs to know who they're
      // actually picking up, since it may not be whoever paid for the ride.
      recipient_name: bookingForSomeoneElse ? recipientName.trim() || null : null,
      recipient_phone: bookingForSomeoneElse ? recipientPhone.trim() || null : null,
    }).select().single();

    // Best-effort "share" — if the recipient's number happens to already
    // belong to a registered Luma client, let them know a ride is coming for
    // them. No SMS gateway exists yet, so this only reaches people who
    // already have the app; that's a real limitation worth knowing, not a
    // silent gap — there's no way yet to notify someone who isn't a user.
    if (bookingForSomeoneElse && recipientPhone.trim() && data) {
      const { data: recipientProfile } = await supabase.from("profiles").select("id, push_token").eq("phone", recipientPhone.trim()).maybeSingle();
      if (recipientProfile?.push_token) {
        sendPushNotification(
          recipientProfile.push_token,
          "A ride has been booked for you! 🚗",
          `${authName || user?.name || "Someone"} booked a ${service === "tuktuk" ? "Tuk Tuk" : service === "motorbike" ? "Motorbike" : "Car"} to pick you up from ${pickup.split(",")[0]}.`,
          recipientProfile.id
        );
      }
    }

    return data;
  };

  const PAYSTACK_PUBLIC_KEY = "pk_test_bf1a50632c17401a944e134786ff7a9610768d13";
  const VERIFY_PAYMENT_URL = "https://dawdtzqgwhqchjuursjj.supabase.co/functions/v1/verify-payment";
  const CREATE_KYC_SESSION_URL = "https://dawdtzqgwhqchjuursjj.supabase.co/functions/v1/create-kyc-session";
  const PROCESS_WITHDRAWAL_URL = "https://dawdtzqgwhqchjuursjj.supabase.co/functions/v1/process-withdrawal";

  const rebookRide = async (booking: any) => {
    setPickupText(booking.pickup || "");
    setDropoffText(booking.dropoff || "");
    setSelectedService(booking.service || "car");
    setScheduleRide(false);
    setScheduledDay(null);
    setScheduledTime(null);
    setEstFare(null);
    setEstKm(null);
    setPickupPin(null);
    setDropoffPin(null);
    go("bookRide");

    // The old ride's exact coordinates were never stored — only the address
    // text — so re-geocode both here and compute a real fare immediately.
    // Uses the same resilient, progressively-simplified geocoding as the full
    // map viewer, since a plain single-shot search frequently failed on the
    // long, detailed address strings saved from reverse-geocoding — leaving
    // the fare uncalculated and silently falling back to GHS 20.
    const [pickupMatch, dropoffMatch] = await Promise.all([
      booking.pickup ? geocodeResilient(booking.pickup) : Promise.resolve(null),
      booking.dropoff ? geocodeResilient(booking.dropoff) : Promise.resolve(null),
    ]);
    if (pickupMatch) setPickupPin({ latitude: pickupMatch.lat, longitude: pickupMatch.lon });
    if (dropoffMatch) setDropoffPin({ latitude: dropoffMatch.lat, longitude: dropoffMatch.lon });
    if (pickupMatch && dropoffMatch) {
      updateFare(pickupMatch.lat, pickupMatch.lon, dropoffMatch.lat, dropoffMatch.lon);
    } else {
      // Couldn't confidently re-pin one or both ends — don't guess at a fare.
      // The client will see the normal "search/select address" flow and get
      // an accurate fare once they confirm pickup and dropoff themselves.
      showAlert("Please confirm your route", "We couldn't automatically re-locate one of your previous stops — please confirm pickup and dropoff to get an accurate fare.");
    }
  };

  const [submittingRide, setSubmittingRide] = useState(false);
  const submitRide = async () => {
    if (submittingRide) return;
    setSubmittingRide(true);
    try {
    if (!pickupText || !dropoffText) { showAlert("Missing", "Please enter pickup and dropoff"); return; }
    if (scheduleRide && (!scheduledDay || !scheduledTime)) {
      showAlert("Missing", "Please select a day and time for your scheduled ride.");
      return;
    }

    // Block new bookings while a cancellation fee is unpaid — the previous approach
    // (just re-prompting payment) had no real teeth: a client could dismiss it
    // indefinitely and keep booking normally. This closes that gap.
    const { data: { user: u } } = await supabase.auth.getUser();
    const clientId = u?.id || "00000000-0000-0000-0000-000000000001";
    const { data: unpaidFees } = await supabase
      .from("bookings")
      .select("id, cancellation_charge")
      .eq("client_id", clientId)
      .eq("status", "cancelled")
      .gt("cancellation_charge", 0)
      .neq("payment_status", "paid");
    if (unpaidFees && unpaidFees.length > 0) {
      const totalOwed = unpaidFees.reduce((sum: number, b: any) => sum + (b.cancellation_charge || 0), 0);
      showAlert(
        "Outstanding Fee",
        `You have GHS ${totalOwed.toFixed(2)} in unpaid cancellation fees. Please clear this before booking a new ride.`,
        [
          { text: "Not Now", style: "cancel" },
          { text: "Pay Now", onPress: () => triggerCancellationFeePayment({ ...unpaidFees[0], payment_method: "card" }) },
        ]
      );
      return;
    }

    const originalFare = estFare || 20;
    const finalFare = calcDiscountedFare(originalFare);
    const methodLabel = paymentMethod === "momo" ? "Mobile Money" : paymentMethod === "card" ? "Card" : "Cash";
    const timingNote = paymentMethod === "cash" ? "You will pay the driver directly." : "You will be charged automatically once the ride is complete.";
    const promoNote = promoApplied ? `\nPromo: ${promoApplied.label}` : "";
    const scheduleNote = scheduleRide
      ? `\nScheduled: ${getNext7Days().find(d => d.key === scheduledDay)?.label} at ${getTimeSlots(scheduledDay!).find(t => t.key === scheduledTime)?.label}`
      : "";
    showAlert(
      scheduleRide ? "Confirm Scheduled Ride" : "Confirm Booking",
      `Fare: GHS ${finalFare}${promoApplied && finalFare !== originalFare ? ` (was GHS ${originalFare})` : ""}\nPayment: ${methodLabel}${promoNote}${scheduleNote}\n\n${timingNote}`,
      [
        { text: "Cancel", style: "cancel" },
        { text: scheduleRide ? "Schedule Ride" : "Book Ride", onPress: () => processBooking(finalFare, originalFare) },
      ]
    );
    } finally {
      setSubmittingRide(false);
    }
  };

  const handlePaystackResult = async (event: any) => {
    try {
      const msg = JSON.parse(event.nativeEvent.data);
      if (msg.type === "success" && msg.reference) {
        setShowPaystack(false);
        // Verify with our secure backend before trusting the payment
        const res = await fetch(VERIFY_PAYMENT_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ reference: msg.reference, bookingId: pendingPaymentBookingId }),
        });
        const data = await res.json();
        if (data.verified) {
          haptic("success");
          // Safety net: confirm the booking is actually marked paid from this session
          // too, in case the backend's own update didn't take effect for any reason —
          // Paystack itself has already confirmed the charge by this point (data.verified
          // only comes back true after the backend verified directly with Paystack), so
          // this isn't bypassing verification, just making sure the result sticks.
          if (pendingPaymentBookingId) {
            const { error: markPaidError } = await supabase.from("bookings").update({ payment_status: "paid" }).eq("id", pendingPaymentBookingId);
            if (markPaidError) {
              showAlert(
                "Payment received, but...",
                "Your payment went through, but we couldn't update your booking record (" + markPaidError.message + "). Please screenshot this and let support know — your money is safe."
              );
            }
          }
          const channelLabel = data.channel === "mobile_money" ? "Mobile Money" : "Card";
          if (data.type === "cancellation_fee") {
            showAlert("Fee Paid", `GHS ${data.amount} cancellation fee paid via ${channelLabel} — sent directly to your driver.`);
            if (pendingPaymentBookingId) {
              const { data: cancelledBooking } = await supabase.from("bookings").select("driver_id").eq("id", pendingPaymentBookingId).maybeSingle();
              if (cancelledBooking?.driver_id) await notifyPaymentReceived(cancelledBooking.driver_id, data.amount, "a cancellation fee");
            }
          } else {
            showAlert("Payment Successful!", `GHS ${data.amount} received via ${channelLabel}`);
          }
        } else {
          showAlert("Payment Failed", "We could not verify your payment. You can retry from My Bookings.");
        }
        setPendingPaymentBookingId(null);
        fetchClientBookings();
      } else if (msg.type === "cancel") {
        setShowPaystack(false);
        setPendingPaymentBookingId(null);
      }
    } catch (e) { setShowPaystack(false); setPendingPaymentBookingId(null); }
  };

  // Called when a booking the client made transitions to "completed" and still needs MoMo/Card payment
  const triggerPaymentForBooking = (booking: any) => {
    if (!authEmail) {
      showAlert("Email Needed", "Please make sure you're logged in with a valid email to pay online.");
      return;
    }
    setPendingPaymentBookingId(booking.id);
    setEstFare(booking.price);
    setPaymentMethod(booking.payment_method === "cash" ? "card" : booking.payment_method);
    setPaymentDescription(`${booking.service === "tuktuk" ? "Tuk Tuk" : booking.service === "motorbike" ? "Motorbike" : "Car"} Ride Fare`);
    setShowPaystack(true);
  };

  // Called to actually collect a cancellation fee — same Paystack flow, but charges
  // the fee amount rather than the ride fare, and defaults to card if the original
  // booking was cash (since there's no MoMo/card on file for a cash payer otherwise).
  const triggerCancellationFeePayment = (booking: any) => {
    if (!authEmail) {
      showAlert("Email Needed", "Please make sure you're logged in with a valid email to pay online.");
      return;
    }
    setPendingPaymentBookingId(booking.id);
    setEstFare(booking.cancellation_charge);
    setPaymentMethod(booking.payment_method === "cash" ? "card" : (booking.payment_method || "card"));
    setPaymentDescription("Cancellation Fee");
    setShowPaystack(true);
  };

  // Creates several separate ride bookings at once — same pickup/dropoff,
  // each one an independent booking dispatched to its own driver, for groups
  // who need more than one car. No promo/credit applied (see note in
  // processBooking above the bulk-check).
  const processBulkBooking = async (fare: number) => {
    setSubmittingBulkBooking(true);
    const createdIds: string[] = [];
    for (let i = 0; i < bookingQuantity; i++) {
      const booking = await saveBookingToSupabase(pickupText, dropoffText, selectedService, fare, paymentMethod, fare, null);
      if (booking) {
        createdIds.push(booking.id);
        const nb = {
          id: booking.id,
          service: selectedService,
          time: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
          status: "pending",
          payment_status: paymentMethod === "cash" ? "n/a" : "awaiting_completion",
          price: fare,
          original_price: fare,
          promo_type: null,
          pickup: pickupText,
          dropoff: dropoffText,
          payment_method: paymentMethod,
          km: estKm,
          promo_code: null,
        };
        setClientBookings(prev => [nb, ...prev]);
        if (!(scheduleRide && scheduledDay && scheduledTime)) {
          notifyOnlineDrivers(pickupText, selectedService, fare, booking.id);
        }
      }
    }
    setSubmittingBulkBooking(false);
    const serviceLabel = selectedService === "tuktuk" ? "Tuk Tuk" : selectedService === "motorbike" ? "Motorbike" : "Car";
    setBookingQuantity(1);
    setBookingForSomeoneElse(false);
    setRecipientName("");
    setRecipientPhone("");
    haptic("success");
    showAlert(
      "Rides Booked! 🚗",
      `${createdIds.length} separate ${serviceLabel} ${createdIds.length === 1 ? "ride has" : "rides have"} been requested — drivers are being assigned to each one individually. Total: GHS ${(fare * createdIds.length).toFixed(2)}.`,
      [{ text: "OK", onPress: () => go("myBookings") }]
    );
  };

  const processBooking = async (finalFare?: number, originalFareParam?: number) => {
    const fare = finalFare !== undefined ? finalFare : (estFare || 20);
    const trueOriginalFare = originalFareParam !== undefined ? originalFareParam : fare;

    // Bulk bookings (multiple separate rides at once) intentionally skip
    // promo/credit/welcome-discount logic entirely — stacking a one-time
    // discount across several simultaneous bookings would be an easy exploit,
    // and the interaction between "apply once" and "apply per-ride" isn't
    // worth the complexity for what's fundamentally a convenience feature.
    if (bookingQuantity > 1) {
      await processBulkBooking(trueOriginalFare);
      return;
    }

    // Auto-apply promo credit if client has any (expires after 7 days — simplified: deduct immediately)
    if (!promoApplied && promoCredit > 0) {
      const creditToUse = Math.min(promoCredit, fare);
      const fareAfterCredit = parseFloat((fare - creditToUse).toFixed(2));
      showAlert(
        "💰 Promo Credit Applied!",
        `GHS ${creditToUse} credit used. Fare reduced from GHS ${fare} to GHS ${fareAfterCredit}.`,
        [{ text: "Great!", onPress: async () => {
          // Deduct credit from profile
          const { data: { user: u } } = await supabase.auth.getUser();
          if (u) {
            await supabase.from("profiles").update({ promo_credit: promoCredit - creditToUse }).eq("id", u.id);
            setPromoCredit(promoCredit - creditToUse);
          }
          await doProcessBooking(fareAfterCredit, trueOriginalFare, "credit");
        }}]
      );
      return;
    }

    // Check and apply welcome discount if eligible and no promo already applied
    if (!promoApplied) {
      const eligible = await checkAndApplyWelcomeDiscount();
      if (eligible) {
        const welcomeFare = parseFloat((fare * 0.75).toFixed(2));
        showAlert(
          "🎉 Welcome Discount!",
          `25% off your first ride! Fare reduced from GHS ${fare} to GHS ${welcomeFare}.`,
          [{ text: "Great!", onPress: async () => {
            await markWelcomeDiscountUsed();
            await doProcessBooking(welcomeFare, trueOriginalFare, "welcome");
          }}]
        );
        return;
      }
    }
    await doProcessBooking(fare, trueOriginalFare, promoApplied?.type || null);
  };

  const doProcessBooking = async (fare: number, originalFare?: number, promoType?: string | null) => {
    const booking = await saveBookingToSupabase(pickupText, dropoffText, selectedService, fare, paymentMethod, originalFare ?? fare, promoType ?? null);
    haptic("success");
    const nb = {
      id: booking?.id || Date.now().toString(),
      service: selectedService,
      time: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
      status: "pending",
      payment_status: paymentMethod === "cash" ? "n/a" : "awaiting_completion",
      price: fare,
      original_price: originalFare ?? fare,
      promo_type: promoType ?? null,
      pickup: pickupText,
      dropoff: dropoffText,
      payment_method: paymentMethod,
      km: estKm,
      promo_code: promoApplied?.type || null,
    };
    setClientBookings(prev => [nb, ...prev]);

    // Notify online drivers of the new request (skip for scheduled rides — they fire later)
    if (!(scheduleRide && scheduledDay && scheduledTime) && booking?.id) {
      notifyOnlineDrivers(pickupText, selectedService, fare, booking.id);
    }

    // Handle referral reward if promo was a referral code
    if (promoApplied?.type === "referral" && promoApplied?.referrerId && booking?.id) {
      await handleReferralReward(booking.id, promoApplied.referrerId);
    }

    // Increment uses_count for admin-generated promo codes
    if (promoApplied?.promoId) {
      const { data: promo } = await supabase.from("promo_codes").select("uses_count").eq("id", promoApplied.promoId).maybeSingle();
      if (promo) {
        await supabase.from("promo_codes").update({ uses_count: (promo.uses_count || 0) + 1 }).eq("id", promoApplied.promoId);
      }
    }

    const fareLabel = promoApplied?.discount >= 100 ? "FREE RIDE" : `GHS ${fare}`;
    const isScheduled = scheduleRide && scheduledDay && scheduledTime;
    const successTitle = isScheduled ? "Ride Scheduled! 📅" : "Ride Booked! 🚗";
    const successMsg = isScheduled
      ? `Your ride is scheduled for ${getNext7Days().find(d => d.key === scheduledDay)?.label} at ${getTimeSlots(scheduledDay!).find(t => t.key === scheduledTime)?.label}. Fare: ${fareLabel}`
      : `Driver is being assigned. Fare: ${fareLabel}`;
    showAlert(successTitle, successMsg, [{ text: "OK", onPress: () => go("myBookings") }]);
    setPickupText(""); setDropoffText(""); setPickupPin(null); setDropoffPin(null);
    setEstFare(null); setEstKm(null); setPromoCode(""); setPromoApplied(null); setPromoError("");
    setScheduleRide(false); setScheduledDay(null); setScheduledTime(null); setExtraStops([]);
    setBookingForSomeoneElse(false); setRecipientName(""); setRecipientPhone("");
  };


  // Notify only online drivers whose vehicle type matches this ride's service —
  // e.g. a car ride request should never reach tuktuk or motorbike riders.
  const notifyOnlineDrivers = async (pickup: string, service: string, price: number, bookingId?: string) => {
    const serviceToRole: Record<string, string> = {
      car: "car_driver",
      tuktuk: "tuktuk_driver",
      motorbike: "motorbike_rider",
    };
    const matchingRole = serviceToRole[service] || "car_driver";
    const { data: drivers } = await supabase
      .from("profiles")
      .select("id, push_token, is_online, role, notif_push, notif_rides")
      .eq("is_online", true)
      .eq("role", matchingRole);
    if (!drivers) return;
    const serviceLabel = service === "tuktuk" ? "Tuk Tuk" : service === "motorbike" ? "Motorbike" : "Car";

    const notifyList = (list: any[], priority: boolean) => {
      list.forEach((d: any) => {
        if (d.notif_push === false || d.notif_rides === false) return;
        const title = priority ? "⭐ A Favourite Client Wants You!" : "New Ride Request! 🚗";
        const body = priority
          ? `You're this client's favourite driver! ${serviceLabel} pickup near ${pickup?.split(",")[0] || "you"} — GHS ${price}. Open the app to accept.`
          : `${serviceLabel} pickup near ${pickup?.split(",")[0] || "you"} — GHS ${price}. Open the app to accept.`;
        sendPushNotification(d.push_token, title, body, d.id);
      });
    };

    // Give favourite drivers real priority — not just a saved list. If the client
    // has any favourites who are currently online, they get notified first and
    // alone; everyone else only gets notified after a short window if the ride
    // is still unaccepted (so a slow/offline favourite never blocks the ride).
    if (bookingId) {
      const { data: { user: u } } = await supabase.auth.getUser();
      const clientId = u?.id || "00000000-0000-0000-0000-000000000001";
      const { data: favourites } = await supabase.from("favourite_drivers").select("driver_id").eq("client_id", clientId);
      const favouriteIds = new Set((favourites || []).map((f: any) => f.driver_id));
      const onlineFavourites = drivers.filter((d: any) => favouriteIds.has(d.id));

      if (onlineFavourites.length > 0) {
        const otherDrivers = drivers.filter((d: any) => !favouriteIds.has(d.id));
        notifyList(onlineFavourites, true);
        setTimeout(async () => {
          const { data: stillPending } = await supabase.from("bookings").select("status").eq("id", bookingId).maybeSingle();
          if (stillPending?.status === "pending") notifyList(otherDrivers, false);
        }, 25000);
        return;
      }
    }

    notifyList(drivers, false);
  };

  // Shows a full-screen, in-app map (OpenStreetMap — free, no API key needed)
  // with a LIVE moving marker — driver's own GPS in "driver" mode, or the
  // driver's live position (already tracked for the client) in "client" mode.
  // Geocodes the stored address text since bookings only save an address string,
  // not lat/lng. Switch this to real Google Maps turn-by-turn once billing is set up.
  // Pickup/dropoff text is often a long, highly-detailed string from
  // reverse-geocoding a GPS pin (e.g. "Shop 4, Rawlings Ave, near Presec Gate,
  // Legon, Accra, Greater Accra Region, Ghana"). Feeding that exact string into
  // a forward address SEARCH frequently fails to match anything, even though
  // the place is real — so retry with progressively simpler versions of the
  // same address before giving up. Shared by openFullMap and rebookRide.
  const geocodeResilient = async (addressText: string): Promise<{ lat: number; lon: number } | null> => {
    const segments = addressText.split(",").map(s => s.trim()).filter(Boolean);
    const attempts = [addressText, segments.slice(0, 3).join(", "), segments.slice(0, 2).join(", "), segments[0]]
      .filter((v, i, arr) => v && arr.indexOf(v) === i);
    for (const attempt of attempts) {
      const results = await searchPlaces(attempt);
      if (results && results.length > 0) return { lat: results[0].lat, lon: results[0].lon };
    }
    return null;
  };

  const openFullMap = async (addressText: string | null | undefined, label: string, mode: "driver" | "client") => {
    if (!addressText) {
      showAlert("No location yet", "This location isn't available yet.");
      return;
    }
    setLoadingFullMap(true);
    const found = await geocodeResilient(addressText);
    setLoadingFullMap(false);

    if (found) {
      setFullMapView({ lat: found.lat, lng: found.lon, label, mode });
    } else {
      // Couldn't pin the exact address — still show the map with live location
      // alone rather than blocking the feature entirely.
      setFullMapView({ lat: null, lng: null, label, mode });
    }
  };

  // While the driver's full map is open, watch their own live GPS position —
  // this is what makes the destination pin actually feel like "tracking" instead
  // of a static snapshot. Stops watching the instant the map is closed.
  useEffect(() => {
    if (!fullMapView || fullMapView.mode !== "driver") { setLiveSelfLocation(null); return; }
    let sub: any;
    let cancelled = false;
    (async () => {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== "granted" || cancelled) return;
      sub = await Location.watchPositionAsync(
        { accuracy: Location.Accuracy.High, timeInterval: 3000, distanceInterval: 5 },
        (loc) => setLiveSelfLocation({ latitude: loc.coords.latitude, longitude: loc.coords.longitude })
      );
    })();
    return () => { cancelled = true; if (sub) sub.remove(); };
  }, [fullMapView?.mode, fullMapView ? 1 : 0]);

  const checkForUnfinishedRide = async () => {
    const { data: { user: u } } = await supabase.auth.getUser();
    if (!u) return;
    const { data } = await supabase
      .from("bookings")
      .select("*")
      .eq("driver_id", u.id)
      .eq("status", "accepted")
      .order("accepted_at", { ascending: false });
    setQueuedRides(data || []);
    setUnfinishedRide(data && data.length > 0 ? data[0] : null);
  };

  const resumeUnfinishedRide = (rideOverride?: any) => {
    const ride = rideOverride || unfinishedRide;
    if (!ride) return;
    setActiveBookingId(ride.id);
    setBookingAcceptedAt(ride.accepted_at ? new Date(ride.accepted_at) : new Date());
    setTripStarted(false);
    setChatOpen(false);
    fetchMessages(ride.id);
    watchDriverLocation(ride.id);
    go("activeRide");
  };

  // Checks for a new pending ride matching this driver's service type, so it can
  // be shown as an in-app popup on whatever screen they're currently viewing —
  // no need to navigate away to see or accept it.
  const seenRideAlertIdsRef = useRef<string[]>([]);
  useEffect(() => { seenRideAlertIdsRef.current = seenRideAlertIds; }, [seenRideAlertIds]);
  const incomingRideAlertRef = useRef<any>(null);
  useEffect(() => { incomingRideAlertRef.current = incomingRideAlert; }, [incomingRideAlert]);

  // Freezes the full-map WebView's starting position the moment it opens, so
  // the HTML/source only gets built ONCE — without this, every 3-second
  // location update would rebuild the html string and hand it to the WebView
  // as a "new" source, causing the whole page (and map) to visibly reload
  // every few seconds instead of just moving smoothly.
  useEffect(() => {
    if (fullMapView && !fullMapWasOpenRef.current) {
      fullMapWasOpenRef.current = true;
      const coord = fullMapView.mode === "driver" ? (liveSelfLocation || location) : (driverLiveLocation || pickupPin || location);
      setFrozenFullMapCoords({
        lat: coord?.latitude ?? fullMapView.lat ?? 6.6,
        lng: coord?.longitude ?? fullMapView.lng ?? -0.9,
      });
    } else if (!fullMapView && fullMapWasOpenRef.current) {
      fullMapWasOpenRef.current = false;
      setFrozenFullMapCoords(null);
    }
  }, [fullMapView]);

  // Moves the live marker smoothly via injectJavaScript on every location
  // update, instead of ever touching the WebView's source again after the
  // initial load above.
  useEffect(() => {
    if (!fullMapView) return;
    const coord = fullMapView.mode === "driver" ? (liveSelfLocation || location) : (driverLiveLocation || pickupPin || location);
    if (coord?.latitude != null && coord?.longitude != null) {
      fullMapWebViewRef.current?.injectJavaScript(
        `window.lumaUpdateLive && window.lumaUpdateLive(${coord.latitude}, ${coord.longitude}); true;`
      );
    }
  }, [liveSelfLocation?.latitude, liveSelfLocation?.longitude, driverLiveLocation?.latitude, driverLiveLocation?.longitude, location?.latitude, location?.longitude, fullMapView]);

  const checkForIncomingRideAlert = async () => {
    if (!online || !user?.role) return;
    const serviceMap: { [key: string]: string } = { car_driver: "car", tuktuk_driver: "tuktuk", motorbike_rider: "motorbike" };
    const myService = serviceMap[user.role];
    if (!myService) return;

    const { data } = await supabase
      .from("bookings")
      .select("*")
      .eq("status", "pending")
      .eq("service", myService)
      .order("created_at", { ascending: false })
      .limit(5);

    // Read from refs, not the closured state directly — this function is called
    // from a setInterval set up once when the driver goes online, so its closure
    // would otherwise keep seeing the seenRideAlertIds/incomingRideAlert values
    // from THAT moment forever, meaning a dismissed ride would never actually
    // stay dismissed and would keep popping back up on every 6-second poll.
    const fresh = (data || []).find((b: any) => !seenRideAlertIdsRef.current.includes(b.id));
    if (fresh && !incomingRideAlertRef.current) {
      setIncomingRideAlert(fresh);
    }
  };

  const dismissRideAlert = () => {
    if (incomingRideAlert) setSeenRideAlertIds(prev => [...prev, incomingRideAlert.id]);
    setIncomingRideAlert(null);
  };

  const acceptOrder = async (bookingId: string) => {
    const { data: { user: u } } = await supabase.auth.getUser();
    const driverId = u?.id || "00000000-0000-0000-0000-000000000002";
    const { data: updatedBooking, error } = await supabase.from("bookings").update({
      status: "accepted",
      driver_id: driverId,
      accepted_at: new Date().toISOString(),
    }).eq("id", bookingId).select().maybeSingle();

    if (!error) {
      haptic("success");
      fetchDriverBookings();
      checkForUnfinishedRide();

      // Notify the client that a driver accepted their ride
      if (updatedBooking?.client_id) {
        const { data: clientProfile } = await supabase.from("profiles").select("push_token").eq("id", updatedBooking.client_id).maybeSingle();
        if (clientProfile?.push_token) {
          sendPushNotification(clientProfile.push_token, "Driver Found! 🚗", "A driver has accepted your ride and is on the way.", updatedBooking.client_id);
        }
      }

      if (!activeBookingId) {
        // Driver is free — jump straight into it, as before.
        setActiveBookingId(bookingId);
        setBookingAcceptedAt(new Date());
        setRideArrivedAtDelivery(false);
        setRideDeliveryProofPhoto(null);
        setTripStarted(false);
        setChatOpen(false);
        fetchMessages(bookingId);
        watchDriverLocation(bookingId);
        go("activeRide");
        showAlert("Accepted!", "You have accepted this ride.");
      } else {
        // Already mid-ride — claim it without interrupting the current one.
        // It'll show up in the queue on Driver Home once this ride is done.
        showAlert("Ride Accepted! 🎉", "It's now in your queue — finish your current ride, then find it from Driver Home.");
      }
    } else {
      showAlert("Error", error.message);
    }
  };

  const completeRide = async () => {
    if (!activeBookingId) return;
    const order = driverBookings.find(b => b.id === activeBookingId);

    // Motorbike Delivery is a parcel/errand service, not passenger transport —
    // require photo proof before completing, same anti-scam reasoning as food delivery.
    if (order?.service === "motorbike" && !rideDeliveryProofPhoto) {
      showAlert("Photo required", "Please take a photo as delivery proof before completing this delivery.");
      return;
    }

    let deliveryPhotoUrl: string | null = null;
    if (order?.service === "motorbike" && rideDeliveryProofPhoto) {
      deliveryPhotoUrl = await uploadImageToStorage(rideDeliveryProofPhoto, "delivery-proof", `ride-${activeBookingId}/delivery.jpg`);
    }

    await supabase.from("bookings").update({
      status: "completed",
      ...(deliveryPhotoUrl ? { delivery_photo: deliveryPhotoUrl } : {}),
    }).eq("id", activeBookingId);
    haptic("success");
    setRideDeliveryProofPhoto(null);

    let cashCommissionOwed = 0;
    let cashCreditedExtra = 0;

    // Handle commission differently based on payment method. Also checks
    // `original_price` here (not just `price`) — a founder ride has price=0,
    // and the old `if (order?.price)` guard skipped this whole block for a
    // falsy 0, meaning a founder ride never even attempted to pay the driver.
    if (order?.price || order?.original_price) {
      const { data: { user: u } } = await supabase.auth.getUser();
      const driverId = u?.id || "00000000-0000-0000-0000-000000000002";
      const isCash = order.payment_method === "cash";

      // Founder and Staff codes are absorbed by the platform (funded from
      // platform commission/float) — the driver is fully protected and earns
      // their normal 85% of the ORIGINAL fare, regardless of what the client
      // actually paid. Every other discount (welcome, referral, custom promo
      // codes) still works exactly as before: driver's cut is based on the
      // discounted price actually charged.
      const isPlatformAbsorbedPromo = order.promo_type === "founder" || order.promo_type === "staff";
      const earningsBaseFare = isPlatformAbsorbedPromo ? (order.original_price ?? order.price) : order.price;
      const protectedEarnings = parseFloat((earningsBaseFare * (1 - PLATFORM_SETTINGS.platform_commission)).toFixed(2));

      const { data: existingWallet } = await supabase
        .from("wallets")
        .select("*")
        .eq("user_id", driverId)
        .maybeSingle();

      if (isCash) {
        // Cash rides: the client pays the driver directly, in person — the platform
        // never touches this money. Normally that means we DEDUCT our 15%
        // commission from the driver's wallet (they collected 100% of the fare
        // themselves, but only 85% was actually theirs to keep). But on a
        // platform-absorbed promo (founder/staff), the client paid less cash
        // than the driver's protected earnings — so instead of deducting, we
        // CREDIT the driver the difference, funded by the platform.
        const walletAdjustment = parseFloat((protectedEarnings - order.price).toFixed(2));
        if (walletAdjustment < 0) {
          cashCommissionOwed = Math.abs(walletAdjustment);
        } else {
          cashCreditedExtra = walletAdjustment;
        }
        if (existingWallet) {
          await supabase.from("wallets").update({
            balance: parseFloat((existingWallet.balance + walletAdjustment).toFixed(2)),
            total_earned: walletAdjustment > 0 ? parseFloat((existingWallet.total_earned + walletAdjustment).toFixed(2)) : existingWallet.total_earned,
            last_updated: new Date().toISOString(),
          }).eq("user_id", driverId);
        } else {
          await supabase.from("wallets").insert({
            user_id: driverId,
            balance: walletAdjustment,
            total_earned: walletAdjustment > 0 ? walletAdjustment : 0,
            total_withdrawn: 0,
            currency: "GHS",
            last_updated: new Date().toISOString(),
          });
        }
        if (cashCreditedExtra > 0) await notifyPaymentReceived(driverId, cashCreditedExtra, "a promo-protected ride");
      } else {
        // MoMo/Card: the platform collected whatever the client actually paid
        // via Paystack (possibly GHS 0 on a free founder ride) — but the driver
        // is credited their full protected earnings regardless. On a normal
        // (non-platform-absorbed) ride this is unchanged: 85% of the price paid.
        const driverEarnings = protectedEarnings;
        if (existingWallet) {
          await supabase.from("wallets").update({
            balance: parseFloat((existingWallet.balance + driverEarnings).toFixed(2)),
            total_earned: parseFloat((existingWallet.total_earned + driverEarnings).toFixed(2)),
            last_updated: new Date().toISOString(),
          }).eq("user_id", driverId);
        } else {
          await supabase.from("wallets").insert({
            user_id: driverId,
            balance: driverEarnings,
            total_earned: driverEarnings,
            total_withdrawn: 0,
            currency: "GHS",
            last_updated: new Date().toISOString(),
          });
        }
        await notifyPaymentReceived(driverId, driverEarnings, "a completed ride");
      }

      // Check driver referral bonus — Blueprint: GHS 15 to referrer after recruit's 10th ride
      await checkDriverReferralBonus(driverId);
    }

    // Notify client that their ride is complete
    if (order?.client_id) {
      const { data: clientProfile } = await supabase.from("profiles").select("push_token").eq("id", order.client_id).maybeSingle();
      if (clientProfile?.push_token) {
        sendPushNotification(clientProfile.push_token, "Ride Complete! ✅", "Your ride has ended. Thanks for riding with Luma!", order.client_id);
      }
    }

    const isCashRide = order?.payment_method === "cash";
    const cashMessage = cashCreditedExtra > 0
      ? `This ride used a platform-covered promo code — you collected less cash than your normal earnings, so GHS ${cashCreditedExtra.toFixed(2)} has been credited to your wallet to make up the difference.`
      : `Since this was a cash ride, GHS ${cashCommissionOwed.toFixed(2)} (our 15% commission) has been deducted from your wallet — you already collected the full fare in person.`;
    setCustomAlert({
      title: "Ride Complete!",
      message: isCashRide ? cashMessage : "If the client chose MoMo or Card, they'll be prompted to pay now — it'll land in your wallet automatically once they do.",
      icon: "checkmark-circle",
      iconColor: "#2DD4BF",
      buttons: [{ text: "OK", onPress: () => go("driverHome") }],
    });
    setActiveBookingId(null);
    fetchDriverBookings();
  };

  // ============================================================
  // DRIVER REFERRAL BONUS — Blueprint: GHS 15 after recruit's 10th completed ride
  // ============================================================
  const checkDriverReferralBonus = async (driverId: string) => {
    // Count this driver's completed rides
    const { data: completedRides } = await supabase
      .from("bookings")
      .select("id")
      .eq("driver_id", driverId)
      .eq("status", "completed");

    const rideCount = completedRides?.length || 0;

    // Only trigger exactly at the 10th completed ride
    if (rideCount === 10) {
      const { data: driverProfile } = await supabase
        .from("profiles")
        .select("referred_by, full_name")
        .eq("id", driverId)
        .maybeSingle();

      if (driverProfile?.referred_by) {
        const referrerId = driverProfile.referred_by;
        const { data: referrerWallet } = await supabase
          .from("wallets")
          .select("*")
          .eq("user_id", referrerId)
          .maybeSingle();

        if (referrerWallet) {
          await supabase.from("wallets").update({
            balance: parseFloat((referrerWallet.balance + 15).toFixed(2)),
            total_earned: parseFloat((referrerWallet.total_earned + 15).toFixed(2)),
            last_updated: new Date().toISOString(),
          }).eq("user_id", referrerId);
        } else {
          await supabase.from("wallets").insert({
            user_id: referrerId,
            balance: 15,
            total_earned: 15,
            total_withdrawn: 0,
            currency: "GHS",
            last_updated: new Date().toISOString(),
          });
        }

        // Notify the referring driver they earned the bonus
        const { data: referrerProfile } = await supabase.from("profiles").select("push_token").eq("id", referrerId).maybeSingle();
        if (referrerProfile?.push_token) {
          sendPushNotification(referrerProfile.push_token, "Referral Bonus Earned! 🎉", "A driver you referred completed their 10th ride. GHS 15 has been added to your wallet.", referrerId);
        }
      }
    }
  };

  // ============================================================
  // WAITING CHARGES — Blueprint: 0-5 mins free, GHS 1/min after, auto-cancel at 15 mins
  // ============================================================
  const startWaitingTimer = (bookingId: string) => {
    const startTime = new Date();
    setDriverArrivedAt(startTime);
    setWaitingCharge(0);
    setWaitingSecondsElapsed(0);
    setTripStarted(false);
    haptic("medium");

    // Notify client that driver has arrived
    const booking = driverBookings.find(b => b.id === bookingId);
    if (booking?.client_id) {
      supabase.from("profiles").select("push_token").eq("id", booking.client_id).maybeSingle().then(({ data: clientProfile }) => {
        if (clientProfile?.push_token) {
          sendPushNotification(clientProfile.push_token, "Driver Has Arrived! 📍", "Your driver is waiting at the pickup location.", booking.client_id);
        }
      });
    }

    // Ticks every second so the free-time countdown feels real, rather than
    // only updating once a minute. The GHS 1/min charge and the 15-min
    // auto-cancel are still computed off actual elapsed minutes underneath.
    const timer = setInterval(async () => {
      const elapsedSeconds = Math.floor((new Date().getTime() - startTime.getTime()) / 1000);
      setWaitingSecondsElapsed(elapsedSeconds);
      const elapsedMinutes = Math.floor(elapsedSeconds / 60);

      if (elapsedMinutes > 15) {
        // Auto-cancel after 15 mins — GHS 10 fee owed by the client
        clearInterval(timer);
        setWaitingTimer(null);
        await supabase.from("bookings").update({
          status: "cancelled",
          cancellation_charge: 10,
          cancellation_reason: "Client no-show — auto cancelled after 15 minutes",
          payment_status: "pending",
        }).eq("id", bookingId);
        showAlert("Auto Cancelled", "Client did not show up. A GHS 10 fee has been applied — it'll reach your wallet once the client's payment is confirmed.");
        go("driverHome");
      } else if (elapsedMinutes > 5) {
        // GHS 1/min after 5 free minutes
        const charge = (elapsedMinutes - 5) * 1;
        setWaitingCharge(charge);
        await supabase.from("bookings").update({ waiting_charge: charge }).eq("id", bookingId);
      }
    }, 1000);

    setWaitingTimer(timer);
  };

  // Driver taps this once the client actually shows up — stops the waiting
  // clock/charge immediately and unlocks the rest of the ride (dropoff
  // navigation, completion). Deliberately does NOT clear driverArrivedAt —
  // that stays set so dropoff navigation and "already arrived" state remain
  // correct; only the interval/charge actually needs to stop.
  const startTrip = () => {
    if (waitingTimer) { clearInterval(waitingTimer); setWaitingTimer(null); }
    setWaitingCharge(0);
    setWaitingSecondsElapsed(0);
    setTripStarted(true);
    haptic("success");
  };

  const stopWaitingTimer = () => {
    if (waitingTimer) { clearInterval(waitingTimer); setWaitingTimer(null); }
    setWaitingCharge(0);
    setWaitingSecondsElapsed(0);
    setDriverArrivedAt(null);
  };

  // Credits the SPECIFIED driver's wallet — never infers from the currently logged-in
  // user, since this is often called by the CLIENT's device (e.g. on cancellation fees),
  // and using auth.getUser() there would credit the wrong person entirely.
  const creditDriverWallet = async (amount: number, driverId: string) => {
    if (!driverId || amount <= 0) return;
    const { data: wallet } = await supabase.from("wallets").select("*").eq("user_id", driverId).maybeSingle();
    if (wallet) {
      await supabase.from("wallets").update({
        balance: parseFloat((wallet.balance + amount).toFixed(2)),
        total_earned: parseFloat((wallet.total_earned + amount).toFixed(2)),
        last_updated: new Date().toISOString(),
      }).eq("user_id", driverId);
    } else {
      // Driver has no wallet row yet — create one so the fee isn't silently lost
      await supabase.from("wallets").insert({
        user_id: driverId,
        balance: amount,
        total_earned: amount,
        total_withdrawn: 0,
        currency: "GHS",
        last_updated: new Date().toISOString(),
      });
    }
  };

  // Notifies any earning user (driver, rider, or restaurant owner) that money has
  // landed in their wallet, including their up-to-date balance — used for every
  // payment event: ride completion, tips, cancellation fees, and food/delivery
  // payouts. Reads the balance fresh so it's accurate even when the credit itself
  // happened moments earlier (client-side or via the backend).
  const notifyPaymentReceived = async (userId: string | null | undefined, amount: number, source: string) => {
    if (!userId || !amount) return;
    const { data: profile } = await supabase.from("profiles").select("push_token").eq("id", userId).maybeSingle();
    const { data: wallet } = await supabase.from("wallets").select("balance").eq("user_id", userId).maybeSingle();
    const balanceLabel = wallet?.balance != null ? `GHS ${wallet.balance.toFixed(2)}` : "your wallet";
    sendPushNotification(
      profile?.push_token,
      "Payment Received 💰",
      `GHS ${amount.toFixed(2)} from ${source}. New balance: ${balanceLabel}.`,
      userId
    );
  };

  // ============================================================
  // CANCELLATION CHARGES — Blueprint spec
  // ============================================================
  const cancelBooking = async (bookingId: string, byClient: boolean = true) => {
    const booking = byClient ? clientBookings.find(b => b.id === bookingId) : driverBookings.find(b => b.id === bookingId);
    if (!booking) return;

    const now = new Date();
    let charge = 0;
    let reason = "";

    if (byClient) {
      if (booking.status === "pending") {
        // Cancel before acceptance — free
        charge = 0; reason = "Cancelled before driver accepted";
      } else if (booking.status === "accepted") {
        const acceptedTime = new Date(booking.accepted_at || now);
        const minutesSinceAccepted = (now.getTime() - acceptedTime.getTime()) / 60000;

        if (minutesSinceAccepted <= 3) {
          // Within 3 min grace — free
          charge = 0; reason = "Cancelled within 3 minute grace period";
        } else if (driverArrivedAt) {
          // Driver already arrived — GHS 10
          charge = 10; reason = "Driver had already arrived";
        } else {
          // After 3 mins, before arrival — GHS 5
          charge = 5; reason = "Cancelled after 3 minute grace period";
        }
      }
    }

    await supabase.from("bookings").update({
      status: "cancelled",
      cancellation_charge: charge,
      cancellation_reason: reason,
      payment_status: charge > 0 ? "pending" : undefined,
    }).eq("id", bookingId);

    // Notify the other party of the cancellation — honest about what's actually happened so far
    if (byClient && booking.driver_id) {
      // Client cancelled → tell the assigned driver
      const { data: driverProfile } = await supabase.from("profiles").select("push_token").eq("id", booking.driver_id).maybeSingle();
      if (driverProfile?.push_token) {
        sendPushNotification(driverProfile.push_token, "Ride Cancelled ❌", charge > 0 ? `The client cancelled. A GHS ${charge} fee is being charged — it'll reach your wallet once payment is confirmed.` : "The client cancelled this ride.", booking.driver_id);
      }
    } else if (!byClient && booking.client_id) {
      // Driver cancelled → tell the client
      const { data: clientProfile } = await supabase.from("profiles").select("push_token").eq("id", booking.client_id).maybeSingle();
      if (clientProfile?.push_token) {
        sendPushNotification(clientProfile.push_token, "Ride Cancelled ❌", "Your driver had to cancel. Please book again — another driver can pick you up.", booking.client_id);
      }
    }

    if (byClient) fetchClientBookings();
    else fetchDriverBookings();
    stopWaitingTimer();

    if (byClient && charge > 0) {
      // Charge the client for real via Paystack — cash-selected bookings default to
      // card, since there's no card/MoMo on file for a cash payer otherwise.
      showAlert(
        "Cancellation Fee",
        `A cancellation fee of GHS ${charge} applies. You'll be asked to pay it now — this goes directly to your driver.`,
        [{ text: "Pay Now", onPress: () => triggerCancellationFeePayment({ ...booking, cancellation_charge: charge, payment_method: booking.payment_method === "cash" ? "card" : booking.payment_method }) }]
      );
    } else if (byClient) {
      showAlert("Booking Cancelled", "No charge applied.", [{ text: "OK", onPress: () => go("clientHome") }]);
    } else {
      showAlert("Booking Cancelled", "No charge applied.", [{ text: "OK", onPress: () => go("driverHome") }]);
    }
  };

  // ============================================================
  // DRIVER WALLET WITHDRAWAL
  // Blueprint: minimum GHS 10, max GHS 2,000/day, always free, instant via MoMo
  // ============================================================
  const withdrawEarnings = async () => {
    if (!driverWallet || driverWallet.balance < 10) {
      showAlert("Minimum Not Met", "You need at least GHS 10 in your wallet to withdraw.");
      return;
    }
    const { data: { user: u } } = await supabase.auth.getUser();
    const { data: profile } = await supabase.from("profiles").select("momo_provider, phone").eq("id", u?.id).maybeSingle();

    // If we already have their Mobile Money details on file, skip straight to confirming
    if (profile?.momo_provider && profile?.phone) {
      setWithdrawMomoProvider(profile.momo_provider);
      setWithdrawMomoNumber(profile.phone);
    } else {
      setWithdrawMomoProvider("");
      setWithdrawMomoNumber(profile?.phone || "");
    }
    setShowWithdrawModal(true);
  };

  const processWithdrawal = async () => {
    if (!driverWallet) return;
    if (!withdrawMomoProvider) { showAlert("Select Network", "Please select your Mobile Money network."); return; }
    if (!withdrawMomoNumber.trim()) { showAlert("Missing Number", "Please enter your Mobile Money number."); return; }

    const amount = Math.min(driverWallet.balance, 2000); // GHS 2,000 daily limit
    setProcessingWithdrawal(true);
    const { data: { user: u } } = await supabase.auth.getUser();

    try {
      const res = await fetch(PROCESS_WITHDRAWAL_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          userId: u?.id,
          amount,
          momoProvider: withdrawMomoProvider,
          momoNumber: withdrawMomoNumber.trim(),
        }),
      });
      const data = await res.json();
      setProcessingWithdrawal(false);
      setShowWithdrawModal(false);

      if (data.success) {
        showAlert("Withdrawal Sent!", `GHS ${data.amount} is on its way to your Mobile Money.`);
        fetchWallet();
      } else {
        showAlert("Withdrawal Failed", data.message || "Something went wrong. Your balance has not been affected.");
      }
    } catch (e: any) {
      setProcessingWithdrawal(false);
      setShowWithdrawModal(false);
      showAlert("Withdrawal Failed", "Could not reach the payment service. Please try again — your balance has not been affected.");
    }
  };


  // CHAT
  // ============================================================
  const sendMessage = async (bookingId: string) => {
    if (!chatInput.trim()) return;
    const { data: sessionData } = await supabase.auth.getSession();
    const u = sessionData?.session?.user;
    const senderId = u?.id || "00000000-0000-0000-0000-000000000003";
    const messageText = chatInput.trim();
    await supabase.from("messages").insert({
      booking_id: bookingId,
      sender_id: senderId,
      sender_name: user?.name || u?.email || "Demo User",
      message: messageText,
    });
    setChatInput("");
    fetchMessages(bookingId);

    // Notify the other party on this booking that a message arrived
    const { data: booking } = await supabase.from("bookings").select("client_id, driver_id").eq("id", bookingId).maybeSingle();
    if (booking) {
      // Whichever party ISN'T the sender is the recipient
      const recipientId = booking.client_id === senderId ? booking.driver_id : booking.client_id;
      if (recipientId) {
        const { data: recipient } = await supabase.from("profiles").select("push_token").eq("id", recipientId).maybeSingle();
        if (recipient?.push_token) {
          const preview = messageText.length > 60 ? messageText.slice(0, 60) + "…" : messageText;
          sendPushNotification(recipient.push_token, `New message from ${user?.name || "your ride"} 💬`, preview, recipientId);
        }
      }
    }
  };

  // Sends a photo in the ride chat. Capped at 5 photos per person per ride —
  // keeps chat storage/costs bounded and matches the blueprint's in-app chat
  // scope (text-first, photos for showing something quickly, not a gallery).
  const CHAT_PHOTO_LIMIT = 5;
  const sendChatPhoto = async (bookingId: string) => {
    const { data: sessionData } = await supabase.auth.getSession();
    const u = sessionData?.session?.user;
    const senderId = u?.id || "00000000-0000-0000-0000-000000000003";

    const { count } = await supabase
      .from("messages")
      .select("id", { count: "exact", head: true })
      .eq("booking_id", bookingId)
      .eq("sender_id", senderId)
      .not("image_url", "is", null);
    if ((count || 0) >= CHAT_PHOTO_LIMIT) {
      showAlert("Photo limit reached", `You can send up to ${CHAT_PHOTO_LIMIT} photos per ride in chat.`);
      return;
    }

    const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (status !== "granted") { showAlert("Permission needed", "Please allow photo access to send a photo in chat."); return; }
    const r = await ImagePicker.launchImageLibraryAsync({ quality: 0.5, allowsEditing: true });
    if (r.canceled) return;

    setUploadingChatPhoto(true);
    const photoUrl = await uploadImageToStorage(r.assets[0].uri, "chat-photos", `${bookingId}/${senderId}/${Date.now()}.jpg`);
    setUploadingChatPhoto(false);
    if (!photoUrl) { showAlert("Upload failed", "Could not send the photo. Please try again."); return; }

    await supabase.from("messages").insert({
      booking_id: bookingId,
      sender_id: senderId,
      sender_name: user?.name || u?.email || "Demo User",
      message: "",
      image_url: photoUrl,
    });
    fetchMessages(bookingId);

    const { data: booking } = await supabase.from("bookings").select("client_id, driver_id").eq("id", bookingId).maybeSingle();
    if (booking) {
      const recipientId = booking.client_id === senderId ? booking.driver_id : booking.client_id;
      if (recipientId) {
        const { data: recipient } = await supabase.from("profiles").select("push_token").eq("id", recipientId).maybeSingle();
        if (recipient?.push_token) {
          sendPushNotification(recipient.push_token, `New photo from ${user?.name || "your ride"} 📷`, "Tap to view in chat.", recipientId);
        }
      }
    }
  };

  // ============================================================
  // SOS
  // ============================================================
  // ============================================================
  // SOS — Blueprint: hold 3s, then 3s countdown with cancel option
  // ============================================================
  const [sosHolding, setSosHolding] = useState(false);
  const [sosCountdown, setSosCountdown] = useState(0);
  const sosHoldTimer = useRef<any>(null);
  const sosCountdownTimer = useRef<any>(null);

  const startSosHold = () => {
    setSosHolding(true);
    haptic("warning");
    sosHoldTimer.current = setTimeout(() => {
      beginSosCountdown();
    }, 3000);
  };

  const cancelSosHold = () => {
    setSosHolding(false);
    clearTimeout(sosHoldTimer.current);
  };

  const beginSosCountdown = () => {
    setSosHolding(false);
    let count = 3;
    setSosCountdown(count);
    sosCountdownTimer.current = setInterval(() => {
      count -= 1;
      setSosCountdown(count);
      if (count <= 0) {
        clearInterval(sosCountdownTimer.current);
        executeSOS();
      }
    }, 1000);
  };

  const cancelSosCountdown = () => {
    clearInterval(sosCountdownTimer.current);
    setSosCountdown(0);
  };

  // ============================================================
  // EMERGENCY CONTACTS
  // ============================================================
  // ============================================================
  // NOTIFICATIONS (in-app history — persists even after push is dismissed)
  // ============================================================
  const fetchNotifications = async () => {
    const { data: { user: u } } = await supabase.auth.getUser();
    if (!u) return;
    const { data } = await supabase
      .from("notifications")
      .select("*")
      .eq("user_id", u.id)
      .order("created_at", { ascending: false })
      .limit(50);
    if (data) {
      setNotifications(data);
      setUnreadCount(data.filter((n: any) => !n.read).length);
    }
  };

  // Shared pull-to-refresh handler — pass whichever fetch function(s) are
  // relevant to the screen being refreshed. Keeps a single `refreshing` flag
  // rather than one per screen, since only one screen is ever visible at a time.
  const handleRefresh = async (...fetchFns: Array<() => Promise<any> | void>) => {
    setRefreshing(true);
    try {
      await Promise.all(fetchFns.map(fn => fn()));
    } finally {
      setRefreshing(false);
    }
  };

  const markNotificationRead = async (id: string) => {
    setNotifications(prev => prev.map(n => n.id === id ? { ...n, read: true } : n));
    setUnreadCount(prev => Math.max(0, prev - 1));
    await supabase.from("notifications").update({ read: true }).eq("id", id);
  };

  const markAllNotificationsRead = async () => {
    const { data: { user: u } } = await supabase.auth.getUser();
    if (!u) return;
    setNotifications(prev => prev.map(n => ({ ...n, read: true })));
    setUnreadCount(0);
    await supabase.from("notifications").update({ read: true }).eq("user_id", u.id).eq("read", false);
  };

  const fetchEmergencyContacts = async () => {
    const { data: { user: u } } = await supabase.auth.getUser();
    if (!u) return;
    const { data } = await supabase.from("emergency_contacts").select("*").eq("user_id", u.id).order("created_at", { ascending: true });
    if (data) setEmergencyContacts(data);
  };

  const addEmergencyContact = async () => {
    if (!newContactName.trim() || !newContactPhone.trim()) {
      showAlert("Missing details", "Please enter both a name and phone number.");
      return;
    }
    if (emergencyContacts.length >= 3) {
      showAlert("Limit reached", "You can save up to 3 emergency contacts.");
      return;
    }
    const { data: { user: u } } = await supabase.auth.getUser();
    if (!u) { showAlert("Sign in required", "Please log in with a real account to save contacts."); return; }
    const { error } = await supabase.from("emergency_contacts").insert({
      user_id: u.id,
      name: newContactName.trim(),
      phone: newContactPhone.trim(),
    });
    if (!error) {
      setNewContactName(""); setNewContactPhone("");
      fetchEmergencyContacts();
    } else {
      showAlert("Error", error.message);
    }
  };

  const removeEmergencyContact = async (id: string) => {
    await supabase.from("emergency_contacts").delete().eq("id", id);
    fetchEmergencyContacts();
  };

  // ============================================================
  // RESTAURANT OWNER — profile, menu, open/closed status
  // ============================================================
  const fetchMyRestaurant = async () => {
    const { data: { user: u } } = await supabase.auth.getUser();
    if (!u) return;
    const { data } = await supabase.from("restaurants").select("*").eq("owner_id", u.id).maybeSingle();
    if (data) { setMyRestaurant(data); fetchMenuItems(data.id); }
  };

  const fetchMenuItems = async (restaurantId: string) => {
    const { data } = await supabase.from("menu_items").select("*").eq("restaurant_id", restaurantId).order("created_at", { ascending: true });
    if (data) setMenuItems(data);
  };

  const toggleRestaurantOpen = async (value: boolean) => {
    if (!myRestaurant) return;
    setMyRestaurant((prev: any) => ({ ...prev, is_open: value }));
    const { error } = await supabase.from("restaurants").update({ is_open: value }).eq("id", myRestaurant.id);
    if (error) {
      setMyRestaurant((prev: any) => ({ ...prev, is_open: !value }));
      showAlert("Couldn't update status", "Please check your connection and try again.");
    }
  };

  const pickMenuItemPhoto = async () => {
    const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (status !== "granted") { showAlert("Permission needed", "Please allow photo access to add a dish photo."); return; }
    const r = await ImagePicker.launchImageLibraryAsync({ quality: 0.6, allowsEditing: true, aspect: [4, 3] });
    if (!r.canceled) setNewItemPhoto(r.assets[0].uri);
  };

  const addMenuItem = async () => {
    if (!myRestaurant) { showAlert("Error", "Restaurant profile not found. Please contact support."); return; }
    if (!newItemName.trim() || !newItemPrice.trim()) { showAlert("Missing details", "Please enter a name and price."); return; }
    const price = parseFloat(newItemPrice);
    if (isNaN(price) || price <= 0) { showAlert("Invalid price", "Please enter a valid price."); return; }
    if (!newItemPhoto) { showAlert("Photo required", "Please add a photo of this dish — it helps clients decide what to order."); return; }

    setUploadingMenuItem(true);
    const photoUrl = await uploadImageToStorage(newItemPhoto, "menu-photos", `${myRestaurant.id}/${Date.now()}.jpg`);
    if (!photoUrl) {
      setUploadingMenuItem(false);
      showAlert("Upload failed", "Could not upload the photo. Please try again.");
      return;
    }
    const { error } = await supabase.from("menu_items").insert({
      restaurant_id: myRestaurant.id,
      name: newItemName.trim(),
      description: newItemDesc.trim() || null,
      price,
      category: newItemCategory.trim() || null,
      photo_url: photoUrl,
      is_available: true,
    });
    setUploadingMenuItem(false);
    if (error) { showAlert("Error", error.message); return; }
    setNewItemName(""); setNewItemDesc(""); setNewItemPrice(""); setNewItemCategory(""); setNewItemPhoto(null);
    fetchMenuItems(myRestaurant.id);
    showAlert("Added!", `${newItemName} is now on your menu.`);
  };

  const toggleMenuItemAvailable = async (item: any) => {
    setMenuItems(prev => prev.map(m => m.id === item.id ? { ...m, is_available: !m.is_available } : m));
    await supabase.from("menu_items").update({ is_available: !item.is_available }).eq("id", item.id);
  };

  const deleteMenuItem = async (item: any) => {
    showAlert("Remove dish?", `Remove "${item.name}" from your menu?`, [
      { text: "Cancel", style: "cancel" },
      { text: "Remove", style: "destructive", onPress: async () => {
        await supabase.from("menu_items").delete().eq("id", item.id);
        setMenuItems(prev => prev.filter(m => m.id !== item.id));
      }},
    ]);
  };

  // ============================================================
  // CLIENT — browse restaurants, view menu, cart, checkout
  // ============================================================
  const fetchRestaurantList = async () => {
    const { data } = await supabase
      .from("restaurants")
      .select("*")
      .eq("is_approved", true)
      .eq("is_open", true)
      .order("business_name", { ascending: true });
    if (data) setRestaurantList(data);
  };

  const openRestaurantMenu = async (restaurant: any) => {
    setViewingRestaurant(restaurant);
    setFoodCart([]); // fresh cart per restaurant visit
    const { data } = await supabase
      .from("menu_items")
      .select("*")
      .eq("restaurant_id", restaurant.id)
      .eq("is_available", true)
      .order("category", { ascending: true });
    setViewingMenu(data || []);
    go("restaurantMenu");
  };

  const addToCart = (item: any) => {
    setFoodCart(prev => {
      const existing = prev.find(c => c.item.id === item.id);
      if (existing) return prev.map(c => c.item.id === item.id ? { ...c, quantity: c.quantity + 1 } : c);
      return [...prev, { item, quantity: 1 }];
    });
  };

  const removeFromCart = (itemId: string) => {
    setFoodCart(prev => {
      const existing = prev.find(c => c.item.id === itemId);
      if (existing && existing.quantity > 1) return prev.map(c => c.item.id === itemId ? { ...c, quantity: c.quantity - 1 } : c);
      return prev.filter(c => c.item.id !== itemId);
    });
  };

  const cartTotal = () => foodCart.reduce((sum, c) => sum + c.item.price * c.quantity, 0);

  // Same fee formula as Section 3 of the blueprint: GHS 3 base + GHS 4/km, GHS 10 minimum
  const calcDeliveryFee = (km: number) => {
    const fee = 3 + km * 4;
    return parseFloat(Math.max(10, fee).toFixed(2));
  };

  const submitFoodOrder = async (deliveryAddress: string, deliveryLat: number, deliveryLng: number, paymentMethodChoice: string) => {
    if (!viewingRestaurant || foodCart.length === 0) return;
    const { data: { user: u } } = await supabase.auth.getUser();
    const clientId = u?.id || "00000000-0000-0000-0000-000000000001";

    const km = viewingRestaurant.lat && viewingRestaurant.lng
      ? getDist(viewingRestaurant.lat, viewingRestaurant.lng, deliveryLat, deliveryLng)
      : 2; // fallback estimate if restaurant has no stored location yet
    const deliveryFee = calcDeliveryFee(km);
    const subtotal = cartTotal();
    const total = parseFloat((subtotal + deliveryFee).toFixed(2));

    const { data: order, error } = await supabase.from("food_orders").insert({
      client_id: clientId,
      client_name: user?.name || "Client",
      restaurant_id: viewingRestaurant.id,
      restaurant_name: viewingRestaurant.business_name,
      delivery_address: deliveryAddress,
      delivery_lat: deliveryLat,
      delivery_lng: deliveryLng,
      subtotal,
      delivery_fee: deliveryFee,
      total,
      payment: paymentMethodChoice,
      payment_status: "awaiting_completion",
      delivery_fee_status: "pending", // not due yet — client pays this separately once delivered
      status: "pending",
    }).select().single();

    if (error || !order) { showAlert("Error", error?.message || "Could not place order."); return; }

    const itemRows = foodCart.map(c => ({
      order_id: order.id,
      menu_item_id: c.item.id,
      item_name: c.item.name,
      item_price: c.item.price,
      quantity: c.quantity,
    }));
    await supabase.from("food_order_items").insert(itemRows);

    // Client pays for the FOOD only right now. The delivery fee is charged
    // separately, automatically, once the rider actually delivers — the restaurant
    // is not notified until this food payment is confirmed.
    setFoodPaymentOrderId(order.id);
    setFoodPaymentAmount(subtotal);
    setFoodPaymentMethod(paymentMethodChoice);
    setShowFoodPaystack(true);
  };

  const notifyRestaurantOfNewOrder = async (order: any, total: number) => {
    const { data: restaurant } = await supabase.from("restaurants").select("owner_id, business_name").eq("id", order.restaurant_id).maybeSingle();
    if (!restaurant?.owner_id) return;
    const { data: ownerProfile } = await supabase.from("profiles").select("id, push_token").eq("id", restaurant.owner_id).maybeSingle();
    if (ownerProfile?.push_token) {
      sendPushNotification(ownerProfile.push_token, "New Food Order! 🍔", `${user?.name || "A client"} ordered from ${restaurant.business_name} — GHS ${total} (food only, paid).`, ownerProfile.id);
    }
  };

  const handleFoodPaystackResult = async (event: any) => {
    try {
      const msg = JSON.parse(event.nativeEvent.data);
      setShowFoodPaystack(false);
      if (msg.type === "success") {
        const res = await fetch(VERIFY_PAYMENT_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ reference: msg.reference, bookingId: foodPaymentOrderId, paymentType: "food_order" }),
        });
        const data = await res.json();
        if (data.verified) {
          haptic("success");
          const { data: order } = await supabase.from("food_orders").select("*").eq("id", foodPaymentOrderId).maybeSingle();
          if (order) await notifyRestaurantOfNewOrder(order, data.amount);
          setFoodCart([]);
          setCustomAlert({
            title: "Payment Successful! 🍔",
            message: "Your order has been sent to the restaurant.",
            icon: "fast-food",
            iconColor: "#2DD4BF",
            buttons: [{ text: "OK", onPress: () => { setActiveFoodOrderId(foodPaymentOrderId); go("foodOrderTracking"); } }],
          });
        } else {
          showAlert("Payment Failed", "Your order was saved but not sent — the restaurant won't see it until payment succeeds. You can retry from My Food Orders.");
          go("myFoodOrders");
        }
      } else {
        showAlert("Payment Cancelled", "Your order was saved but not sent to the restaurant. You can retry payment from My Food Orders.");
        go("myFoodOrders");
      }
    } catch (e) {
      setShowFoodPaystack(false);
      showAlert("Payment Failed", "Something went wrong verifying your payment.");
      go("myFoodOrders");
    }
    setFoodPaymentOrderId(null);
    setFoodPaymentAmount(0);
  };

  const handleDeliveryFeePaystackResult = async (event: any) => {
    try {
      const msg = JSON.parse(event.nativeEvent.data);
      setShowDeliveryFeePaystack(false);
      if (msg.type === "success") {
        const res = await fetch(VERIFY_PAYMENT_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ reference: msg.reference, bookingId: deliveryFeeOrderId, paymentType: "delivery_fee" }),
        });
        const data = await res.json();
        if (data.verified) {
          haptic("success");
          showAlert("Payment Successful! 🎉", "Thanks — your rider has been paid for the delivery.");
          if (deliveryFeeOrderId) {
            const { data: deliveredOrder } = await supabase.from("food_orders").select("rider_id, delivery_fee").eq("id", deliveryFeeOrderId).maybeSingle();
            if (deliveredOrder?.rider_id) await notifyPaymentReceived(deliveredOrder.rider_id, deliveredOrder.delivery_fee || data.amount, "a delivery fee");
          }
          fetchFoodOrders();
        } else {
          showAlert("Payment Failed", "We could not verify your payment. You can retry from My Food Orders.");
        }
      } else {
        showAlert("Payment Cancelled", "You can pay the delivery fee anytime from My Food Orders.");
      }
    } catch (e) {
      setShowDeliveryFeePaystack(false);
      showAlert("Payment Failed", "Something went wrong verifying your payment.");
    }
    setDeliveryFeeOrderId(null);
    setDeliveryFeeAmount(0);
  };

  const fetchFoodOrders = async () => {
    const { data: { user: u } } = await supabase.auth.getUser();
    const clientId = u?.id || "00000000-0000-0000-0000-000000000001";
    const { data } = await supabase.from("food_orders").select("*").eq("client_id", clientId).order("created_at", { ascending: false });
    if (data) {
      setFoodOrders(data);

      const isRecent = (dateStr: string) => Date.now() - new Date(dateStr).getTime() < 2 * 60 * 60 * 1000;

      // Auto-trigger the delivery fee payment the moment the rider delivers —
      // checked first, before the rating prompt, so payment happens first.
      const needsDeliveryFeePayment = data.find((o: any) =>
        o.status === "delivered" &&
        o.delivery_fee_status === "awaiting_payment" &&
        isRecent(o.created_at) &&
        !showDeliveryFeePaystack
      );
      if (needsDeliveryFeePayment && deliveryFeeOrderId !== needsDeliveryFeePayment.id) {
        setDeliveryFeeOrderId(needsDeliveryFeePayment.id);
        setDeliveryFeeAmount(needsDeliveryFeePayment.delivery_fee);
        setShowDeliveryFeePaystack(true);
        return;
      }

      // Auto-prompt for a rating once an order is delivered AND the delivery fee
      // is settled — same 2-hour recency guard used for ride ratings, so old
      // test/stale orders can never re-trigger this.
      const needsFoodRating = data.find((o: any) =>
        o.status === "delivered" &&
        o.delivery_fee_status !== "awaiting_payment" &&
        !o.food_rating &&
        isRecent(o.created_at) &&
        !showFoodRatingModal
      );
      if (needsFoodRating && pendingFoodRatingOrderId !== needsFoodRating.id) {
        openFoodRatingModal(needsFoodRating.id);
      }
    }
  };

  // ============================================================
  // LOST & FOUND
  // ============================================================
  const pickLostItemPhoto = async () => {
    const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (status !== "granted") { showAlert("Permission needed", "Please allow photo access to add a photo of the item."); return; }
    const r = await ImagePicker.launchImageLibraryAsync({ quality: 0.6, allowsEditing: true, aspect: [4, 3] });
    if (!r.canceled) setLostItemPhoto(r.assets[0].uri);
  };

  const submitLostItemReport = async () => {
    if (!lostItemBookingId) { showAlert("Error", "No ride selected."); return; }
    if (!lostItemDesc.trim()) { showAlert("Missing details", "Please describe the item you lost."); return; }

    setSubmittingLostItem(true);
    const { data: { user: u } } = await supabase.auth.getUser();
    const clientId = u?.id || "00000000-0000-0000-0000-000000000001";

    const { data: booking } = await supabase.from("bookings").select("driver_id").eq("id", lostItemBookingId).maybeSingle();

    // Fetch the driver's contact details now, so the client can call them directly
    // once the item is found — not just message in-app.
    let driverProfile: any = null;
    if (booking?.driver_id) {
      const { data } = await supabase.from("profiles").select("full_name, phone, push_token").eq("id", booking.driver_id).maybeSingle();
      driverProfile = data;
    }

    let photoUrl: string | null = null;
    if (lostItemPhoto) {
      photoUrl = await uploadImageToStorage(lostItemPhoto, "lost-items", `${clientId}/${Date.now()}.jpg`);
    }

    const { error } = await supabase.from("lost_items").insert({
      booking_id: lostItemBookingId,
      client_id: clientId,
      client_name: user?.name || "Client",
      driver_id: booking?.driver_id || null,
      driver_name: driverProfile?.full_name || null,
      driver_phone: driverProfile?.phone || null,
      item_description: lostItemDesc.trim(),
      item_photo: photoUrl,
      status: "reported",
    });

    setSubmittingLostItem(false);
    if (error) { showAlert("Error", error.message); return; }

    // Notify the driver right away
    if (driverProfile?.push_token) {
      sendPushNotification(driverProfile.push_token, "Lost Item Reported 🔍", `${user?.name || "A client"} thinks they left something in your vehicle. Check Lost & Found in the app.`, booking.driver_id);
    }

    setLostItemDesc(""); setLostItemPhoto(null); setLostItemBookingId(null);
    showAlert("Reported", "Your driver has been notified. You can track the status in Lost & Found.", [
      { text: "OK", onPress: () => go("myLostItems") },
    ]);
  };

  const fetchMyLostItems = async () => {
    const { data: { user: u } } = await supabase.auth.getUser();
    const clientId = u?.id || "00000000-0000-0000-0000-000000000001";
    const { data } = await supabase.from("lost_items").select("*").eq("client_id", clientId).order("created_at", { ascending: false });
    if (data) setMyLostItems(data);
  };

  const fetchDriverLostItemReports = async () => {
    const { data: { user: u } } = await supabase.auth.getUser();
    const driverId = u?.id || "00000000-0000-0000-0000-000000000002";
    const { data } = await supabase.from("lost_items").select("*").eq("driver_id", driverId).order("created_at", { ascending: false });
    if (data) setDriverLostItemReports(data);
  };

  const markLostItemFound = async (itemId: string) => {
    await supabase.from("lost_items").update({ status: "found" }).eq("id", itemId);
    fetchDriverLostItemReports();

    const item = driverLostItemReports.find(i => i.id === itemId);
    if (item?.client_id) {
      const { data: clientProfile } = await supabase.from("profiles").select("push_token").eq("id", item.client_id).maybeSingle();
      if (clientProfile?.push_token) {
        sendPushNotification(clientProfile.push_token, "Item Found! 🎉", "Your driver found your item. Call them to arrange getting it back — their number is in Lost & Found.", item.client_id);
      }
    }
  };

  // ============================================================
  // RESTAURANT — incoming orders, accept, mark ready
  // ============================================================
  const fetchIncomingFoodOrders = async () => {
    if (!myRestaurant) return;
    const { data } = await supabase.from("food_orders").select("*").eq("restaurant_id", myRestaurant.id).order("created_at", { ascending: false });
    if (data) setIncomingFoodOrders(data);
  };

  const acceptFoodOrder = async (orderId: string) => {
    await supabase.from("food_orders").update({ status: "preparing" }).eq("id", orderId);
    fetchIncomingFoodOrders();

    const order = incomingFoodOrders.find(o => o.id === orderId);
    if (order?.client_id) {
      const { data: clientProfile } = await supabase.from("profiles").select("push_token").eq("id", order.client_id).maybeSingle();
      if (clientProfile?.push_token) {
        sendPushNotification(clientProfile.push_token, "Order Accepted! 👨‍🍳", `${myRestaurant?.business_name} is preparing your food.`, order.client_id);
      }
    }
  };

  const markFoodOrderReady = async (orderId: string) => {
    await supabase.from("food_orders").update({ status: "ready_for_pickup" }).eq("id", orderId);
    fetchIncomingFoodOrders();

    // Notify online motorbike riders that a delivery is ready
    const { data: riders } = await supabase.from("profiles").select("id, push_token, notif_push, notif_rides").eq("is_online", true).eq("role", "motorbike_rider");
    if (riders) {
      const order = incomingFoodOrders.find(o => o.id === orderId);
      riders.forEach((r: any) => {
        if (r.notif_push === false || r.notif_rides === false) return;
        sendPushNotification(r.push_token, "Food Delivery Ready! 🍔", `Pickup from ${myRestaurant?.business_name} — GHS ${order?.delivery_fee || ""} delivery fee. Open the app to accept.`, r.id);
      });
    }
  };

  // ============================================================
  // MOTORBIKE RIDER — available deliveries, accept, fulfil
  // ============================================================
  const fetchAvailableFoodDeliveries = async () => {
    const { data } = await supabase
      .from("food_orders")
      .select("*")
      .eq("status", "ready_for_pickup")
      .order("created_at", { ascending: true });
    if (data) setAvailableFoodDeliveries(data);
  };

  const watchRiderLocation = async (orderId: string) => {
    try {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== "granted") return;
      await Location.watchPositionAsync(
        { accuracy: Location.Accuracy.High, timeInterval: 3000, distanceInterval: 5 },
        (loc) => {
          setRiderLiveLocation({ latitude: loc.coords.latitude, longitude: loc.coords.longitude });
          supabase.from("food_orders").update({
            rider_lat: loc.coords.latitude,
            rider_lng: loc.coords.longitude,
          }).eq("id", orderId);
        }
      );
    } catch (e) {
      console.log("Rider location tracking unavailable:", e);
    }
  };

  const acceptFoodDelivery = async (orderId: string) => {
    const { data: { user: u } } = await supabase.auth.getUser();
    const riderId = u?.id || "00000000-0000-0000-0000-000000000002";
    const { error } = await supabase.from("food_orders").update({
      status: "rider_assigned",
      rider_id: riderId,
    }).eq("id", orderId);
    if (error) { showAlert("Error", error.message); return; }
    setActiveFoodOrderId(orderId);
    setActiveDeliveryStage("pickup");
    watchRiderLocation(orderId);
    go("activeFoodDelivery");
    fetchAvailableFoodDeliveries();
  };

  const takeProofPhoto = async (setter: (uri: string) => void) => {
    const { status } = await ImagePicker.requestCameraPermissionsAsync();
    if (status !== "granted") { showAlert("Camera needed", "Please allow camera access to take a proof photo — this protects both you and the client."); return; }
    const r = await ImagePicker.launchCameraAsync({ quality: 0.5 });
    if (!r.canceled) setter(r.assets[0].uri);
  };

  const markFoodPickedUp = async (orderId: string) => {
    if (!pickupProofPhoto) { showAlert("Photo required", "Please take a photo of the order as pickup proof."); return; }
    setUploadingProof(true);
    const photoUrl = await uploadImageToStorage(pickupProofPhoto, "delivery-proof", `${orderId}/pickup.jpg`);
    setUploadingProof(false);
    await supabase.from("food_orders").update({ status: "picked_up", pickup_photo: photoUrl }).eq("id", orderId);
    setPickupProofPhoto(null);
    // Advance the screen directly — the old code relied on re-finding this order
    // in a local list that never refreshed after this update, so it silently
    // never advanced to the delivery-proof stage.
    setActiveDeliveryStage("delivery");
  };

  const markFoodDelivered = async (orderId: string) => {
    if (!deliveryProofPhoto) { showAlert("Photo required", "Please take a photo as delivery proof."); return; }
    setUploadingProof(true);
    const photoUrl = await uploadImageToStorage(deliveryProofPhoto, "delivery-proof", `${orderId}/delivery.jpg`);
    setUploadingProof(false);

    const { data: order } = await supabase.from("food_orders").select("*").eq("id", orderId).maybeSingle();
    await supabase.from("food_orders").update({
      status: "delivered",
      delivery_photo: photoUrl,
      delivery_fee_status: "awaiting_payment", // triggers the client's payment prompt
    }).eq("id", orderId);
    setDeliveryProofPhoto(null);

    // Adjusts a wallet by a delta (positive = credit, negative = debit), creating
    // the wallet row if it doesn't exist yet. Only positive deltas count toward
    // total_earned — a debit is money owed back, not negative earnings.
    const adjustWallet = async (userId: string, delta: number) => {
      const { data: wallet } = await supabase.from("wallets").select("*").eq("user_id", userId).maybeSingle();
      if (wallet) {
        await supabase.from("wallets").update({
          balance: parseFloat((wallet.balance + delta).toFixed(2)),
          total_earned: delta > 0 ? parseFloat((wallet.total_earned + delta).toFixed(2)) : wallet.total_earned,
          last_updated: new Date().toISOString(),
        }).eq("user_id", userId);
      } else {
        await supabase.from("wallets").insert({
          user_id: userId,
          balance: delta,
          total_earned: delta > 0 ? delta : 0,
          total_withdrawn: 0,
          currency: "GHS",
          last_updated: new Date().toISOString(),
        });
      }
    };

    if (order) {
      // Restaurant already got paid at order time, so credit them now — the
      // rider, however, only gets credited once the client actually pays the
      // delivery fee (triggered automatically next, on the client's side).
      const { data: restaurant } = await supabase.from("restaurants").select("owner_id").eq("id", order.restaurant_id).maybeSingle();
      if (restaurant?.owner_id && order.subtotal) {
        const restaurantEarnings = parseFloat((order.subtotal * (1 - PLATFORM_SETTINGS.food_commission)).toFixed(2));
        await adjustWallet(restaurant.owner_id, restaurantEarnings);
        await notifyPaymentReceived(restaurant.owner_id, restaurantEarnings, "a food order");
      }
    }

    if (order?.client_id) {
      const { data: clientProfile } = await supabase.from("profiles").select("push_token").eq("id", order.client_id).maybeSingle();
      if (clientProfile?.push_token) {
        sendPushNotification(clientProfile.push_token, "Order Delivered! ✅", "Please pay the delivery fee to complete your order.", order.client_id);
      }
    }

    setCustomAlert({
      title: "Delivered!",
      message: "Great job — the client will be prompted to pay the delivery fee now, and it'll land in your wallet once they do.",
      icon: "checkmark-circle",
      iconColor: "#2DD4BF",
      buttons: [{ text: "OK", onPress: () => { setActiveFoodOrderId(null); go("driverHome"); } }],
    });
  };

  // ============================================================
  // REFUNDS
  // ============================================================
  const pickRefundEvidence = async () => {
    const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (status !== "granted") { showAlert("Permission needed", "Please allow photo access to add evidence."); return; }
    const r = await ImagePicker.launchImageLibraryAsync({ quality: 0.6 });
    if (!r.canceled) setRefundEvidence(r.assets[0].uri);
  };

  const submitRefundRequest = async () => {
    if (!refundReason.trim()) { showAlert("Missing reason", "Please explain why you're requesting a refund."); return; }
    if (!refundTargetBookingId && !refundTargetFoodOrderId) { showAlert("Error", "No order selected."); return; }

    setSubmittingRefund(true);
    const { data: { user: u } } = await supabase.auth.getUser();
    const clientId = u?.id || "00000000-0000-0000-0000-000000000001";

    let amount = 0;
    let paymentReference: string | null = null;

    if (refundTargetBookingId) {
      const { data: booking } = await supabase.from("bookings").select("price, payment_reference").eq("id", refundTargetBookingId).maybeSingle();
      amount = booking?.price || 0;
      paymentReference = booking?.payment_reference || null;
    } else if (refundTargetFoodOrderId) {
      const { data: order } = await supabase.from("food_orders").select("total, payment_reference").eq("id", refundTargetFoodOrderId).maybeSingle();
      amount = order?.total || 0;
      paymentReference = order?.payment_reference || null;
    }

    if (!paymentReference) {
      setSubmittingRefund(false);
      showAlert("Can't Request Refund", "This order doesn't have an online payment on file — refunds are only available for MoMo/Card payments, not cash.");
      return;
    }

    let evidenceUrl: string | null = null;
    if (refundEvidence) {
      evidenceUrl = await uploadImageToStorage(refundEvidence, "refund-evidence", `${clientId}/${Date.now()}.jpg`);
    }

    const { error } = await supabase.from("refund_requests").insert({
      booking_id: refundTargetBookingId,
      food_order_id: refundTargetFoodOrderId,
      client_id: clientId,
      client_name: user?.name || "Client",
      amount,
      reason: refundReason.trim(),
      evidence_photo: evidenceUrl,
      payment_reference: paymentReference,
      status: "pending",
    });

    setSubmittingRefund(false);
    if (error) { showAlert("Error", error.message); return; }

    setRefundReason(""); setRefundEvidence(null); setRefundTargetBookingId(null); setRefundTargetFoodOrderId(null);
    setCustomAlert({
      title: "Refund Requested",
      message: "An admin will review your request shortly. You can track its status in My Refund Requests.",
      icon: "cash",
      iconColor: "#2DD4BF",
      buttons: [{ text: "OK", onPress: () => go("myRefundRequests") }],
    });
  };

  const fetchMyRefundRequests = async () => {
    const { data: { user: u } } = await supabase.auth.getUser();
    const clientId = u?.id || "00000000-0000-0000-0000-000000000001";
    const { data } = await supabase.from("refund_requests").select("*").eq("client_id", clientId).order("created_at", { ascending: false });
    if (data) setMyRefundRequests(data);
  };

  const executeSOS = async () => {
    setSosActive(true);
    setSosCountdown(0);
    haptic("error");

    const { data: { user: u } } = await supabase.auth.getUser();

    // 1) Flag the ride and record the SOS event
    if (location && activeBookingId) {
      await supabase.from("bookings").update({
        sos_triggered: true,
        sos_lat: location.latitude,
        sos_lng: location.longitude,
      }).eq("id", activeBookingId);
    }
    // Log a standalone SOS alert record (so admin has a dedicated feed, not just a booking flag)
    await supabase.from("sos_alerts").insert({
      user_id: u?.id || null,
      user_name: user?.name || "Unknown user",
      user_phone: user?.phone || null,
      booking_id: activeBookingId || null,
      lat: location?.latitude || null,
      lng: location?.longitude || null,
      status: "active",
    });

    // 2) Alert every admin by push (real)
    const { data: admins } = await supabase.from("profiles").select("id, push_token").eq("role", "admin");
    if (admins) {
      admins.forEach((a: any) => {
        sendPushNotification(a.push_token, "🚨 SOS ALERT", `${user?.name || "A user"} triggered SOS${location ? ` at ${location.latitude.toFixed(4)}, ${location.longitude.toFixed(4)}` : ""}. Check the dashboard now.`, a.id);
      });
    }

    // 3) Notify saved emergency contacts (in-app record for now; real SMS pending provider)
    let contactNote = "";
    if (u) {
      const { data: contacts } = await supabase.from("emergency_contacts").select("name, phone").eq("user_id", u.id);
      if (contacts && contacts.length > 0) {
        contactNote = `\nYour ${contacts.length} emergency contact${contacts.length > 1 ? "s have" : " has"} been recorded for follow-up.`;
      }
    }

    showAlert(
      "🚨 SOS Activated",
      `Your location has been shared with Luma admin.${contactNote}\n\nFor immediate help, call the police now.`,
      [
        { text: "Call Police 191", onPress: () => Linking.openURL("tel:191") },
        { text: "Done", style: "cancel" },
      ]
    );
  };

  // ============================================================
  // DRIVER LOCATION
  // ============================================================
  const watchDriverLocation = async (bookingId: string) => {
    try {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== "granted") return;
      await Location.watchPositionAsync(
        { accuracy: Location.Accuracy.High, timeInterval: 3000, distanceInterval: 5 },
        (loc) => {
          supabase.from("bookings").update({
          driver_lat: loc.coords.latitude,
          driver_lng: loc.coords.longitude,
        }).eq("id", bookingId);
      }
    );
    } catch (e) {
      console.log("Location tracking unavailable:", e);
    }
  };

  // ============================================================
  // IMAGE PICKER
  // ============================================================
  const pickPhoto = async (setter: (uri: string) => void) => {
    const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (status !== "granted") { showAlert("Permission needed"); return; }
    const r = await ImagePicker.launchImageLibraryAsync({
      quality: 0.7,
    });
    if (!r.canceled) setter(r.assets[0].uri);
  };

  const [uploadingPhoto, setUploadingPhoto] = useState(false);

  // ============================================================
  // FOOD DELIVERY STATE
  // ============================================================
  const [myRestaurant, setMyRestaurant] = useState<any>(null);
  const [menuItems, setMenuItems] = useState<any[]>([]);
  const [uploadingMenuItem, setUploadingMenuItem] = useState(false);
  const [newItemName, setNewItemName] = useState("");
  const [newItemDesc, setNewItemDesc] = useState("");
  const [newItemPrice, setNewItemPrice] = useState("");
  const [newItemCategory, setNewItemCategory] = useState("");
  const [newItemPhoto, setNewItemPhoto] = useState<string | null>(null);

  // Client-facing food browsing/ordering
  const [restaurantList, setRestaurantList] = useState<any[]>([]);
  const [viewingRestaurant, setViewingRestaurant] = useState<any>(null);
  const [viewingMenu, setViewingMenu] = useState<any[]>([]);
  const [foodCart, setFoodCart] = useState<{ item: any; quantity: number }[]>([]);
  const [foodOrders, setFoodOrders] = useState<any[]>([]);
  const [activeFoodOrderId, setActiveFoodOrderId] = useState<string | null>(null);
  const [activeDeliveryStage, setActiveDeliveryStage] = useState<"pickup" | "delivery">("pickup");
  const [showFoodPaystack, setShowFoodPaystack] = useState(false);
  const [foodPaymentOrderId, setFoodPaymentOrderId] = useState<string | null>(null);
  const [foodPaymentAmount, setFoodPaymentAmount] = useState(0);
  const [foodPaymentMethod, setFoodPaymentMethod] = useState("card");
  const [showDeliveryFeePaystack, setShowDeliveryFeePaystack] = useState(false);
  const [deliveryFeeOrderId, setDeliveryFeeOrderId] = useState<string | null>(null);
  const [deliveryFeeAmount, setDeliveryFeeAmount] = useState(0);
  const [deliveryFeePaymentMethod, setDeliveryFeePaymentMethod] = useState("momo");
  const [pickupProofPhoto, setPickupProofPhoto] = useState<string | null>(null);

  // ============================================================
  // REFUNDS
  // ============================================================
  const [refundTargetBookingId, setRefundTargetBookingId] = useState<string | null>(null);
  const [refundTargetFoodOrderId, setRefundTargetFoodOrderId] = useState<string | null>(null);
  const [refundReason, setRefundReason] = useState("");
  const [refundEvidence, setRefundEvidence] = useState<string | null>(null);
  const [submittingRefund, setSubmittingRefund] = useState(false);
  const [myRefundRequests, setMyRefundRequests] = useState<any[]>([]);
  const [deliveryProofPhoto, setDeliveryProofPhoto] = useState<string | null>(null);
  const [rideDeliveryProofPhoto, setRideDeliveryProofPhoto] = useState<string | null>(null);
  const [rideArrivedAtDelivery, setRideArrivedAtDelivery] = useState(false);
  const [uploadingProof, setUploadingProof] = useState(false);

  // ============================================================
  // LOST & FOUND STATE
  // ============================================================
  const [lostItemBookingId, setLostItemBookingId] = useState<string | null>(null);
  const [lostItemDesc, setLostItemDesc] = useState("");
  const [lostItemPhoto, setLostItemPhoto] = useState<string | null>(null);
  const [submittingLostItem, setSubmittingLostItem] = useState(false);
  const [myLostItems, setMyLostItems] = useState<any[]>([]);
  const [driverLostItemReports, setDriverLostItemReports] = useState<any[]>([]);
  const [foodDeliveryAddress, setFoodDeliveryAddress] = useState("");
  const [foodDeliveryPayment, setFoodDeliveryPayment] = useState("momo");
  const [incomingFoodOrders, setIncomingFoodOrders] = useState<any[]>([]);
  const [availableFoodDeliveries, setAvailableFoodDeliveries] = useState<any[]>([]);

  // Let a driver pick and upload a public profile photo to Supabase Storage
  // Generic helper: uploads a local image URI to any Supabase Storage bucket/path,
  // returns the public URL. Used for profile photos, restaurant photos, menu items, etc.
  const uploadImageToStorage = async (localUri: string, bucket: string, path: string): Promise<string | null> => {
    try {
      const resp = await fetch(localUri);
      const arrayBuffer = await resp.arrayBuffer();
      const { error: uploadError } = await supabase.storage
        .from(bucket)
        .upload(path, arrayBuffer, { contentType: "image/jpeg", upsert: true });
      if (uploadError) throw uploadError;
      const { data: urlData } = supabase.storage.from(bucket).getPublicUrl(path);
      return `${urlData.publicUrl}?t=${Date.now()}`; // cache-bust so updates show immediately
    } catch (e: any) {
      console.log("Image upload failed:", e?.message || e);
      return null;
    }
  };

  // For sensitive documents (Ghana Card, licenses, certificates) — uploads to a PRIVATE
  // bucket and returns only the storage path, never a public URL. Only admins can view
  // these later, and only via a short-lived signed link generated on demand.
  const uploadPrivateDocument = async (localUri: string, bucket: string, path: string): Promise<string | null> => {
    try {
      const resp = await fetch(localUri);
      const arrayBuffer = await resp.arrayBuffer();
      const { error: uploadError } = await supabase.storage
        .from(bucket)
        .upload(path, arrayBuffer, { contentType: "image/jpeg", upsert: true });
      if (uploadError) throw uploadError;
      return path;
    } catch (e: any) {
      console.log("Private document upload failed:", e?.message || e);
      return null;
    }
  };

  const uploadProfilePhoto = async () => {
    const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (status !== "granted") { showAlert("Permission needed", "Please allow photo access to set a profile picture."); return; }
    const r = await ImagePicker.launchImageLibraryAsync({ quality: 0.6, allowsEditing: true, aspect: [1, 1] });
    if (r.canceled) return;

    setUploadingPhoto(true);
    try {
      // Prefer the cached session (reliable, no network round-trip); fall back to getUser
      const { data: sessionData } = await supabase.auth.getSession();
      let u = sessionData?.session?.user;
      if (!u) {
        const { data: userData } = await supabase.auth.getUser();
        u = userData?.user || undefined;
      }
      if (!u) {
        setUploadingPhoto(false);
        showAlert("Sign in required", "Profile photos can only be set on a real account. Demo accounts can't upload — please log in with an account you signed up and confirmed by email.");
        return;
      }

      const uri = r.assets[0].uri;
      const resp = await fetch(uri);
      const arrayBuffer = await resp.arrayBuffer();
      const fileName = `${u.id}/profile.jpg`;

      const { error: uploadError } = await supabase.storage
        .from("profile-photos")
        .upload(fileName, arrayBuffer, { contentType: "image/jpeg", upsert: true });
      if (uploadError) { throw uploadError; }

      const { data: urlData } = supabase.storage.from("profile-photos").getPublicUrl(fileName);
      // Cache-bust so the new image shows immediately
      const publicUrl = `${urlData.publicUrl}?t=${Date.now()}`;

      await supabase.from("profiles").update({ profile_photo: publicUrl }).eq("id", u.id);
      setUser((prev: any) => ({ ...prev, profilePhoto: publicUrl }));
      showAlert("Photo updated!", "Your profile picture is now visible to clients.");
    } catch (e: any) {
      showAlert("Upload failed", e?.message || "Could not upload photo. Please try again.");
    } finally {
      setUploadingPhoto(false);
    }
  };

  // Starts an instant identity verification via Didit — a hosted, Didit-branded
  // flow (selfie + Ghana Card capture) opened in a WebView. The actual
  // approve/decline decision comes back later via a Supabase Edge Function
  // webhook (not through this WebView directly), which updates is_verified on
  // the profile automatically. This sits ALONGSIDE the manual document upload
  // flow below, not replacing it — either path gets a driver verified.
  // Saves vehicle info after Didit verification — no photos, no admin
  // approval needed, since this is just operational data (what shows up on
  // the client's tracking screen), not an identity/compliance check.
  // EXCEPTION: car drivers also need their actual Driver's License here —
  // Didit only verifies IDENTITY (who someone is), not driving eligibility.
  // A driver's license is a completely separate, real compliance check that
  // the old manual flow used to collect — this restores it as its own step,
  // matching the old rule that only car drivers need one (tuktuk and
  // motorbike never did).
  const submitVehicleDetails = async () => {
    const { data: { user: u } } = await supabase.auth.getUser();
    if (!u) { showAlert("Error", "Please log in again."); return; }
    const needsExpiry = authRole === "car_driver" || authRole === "tuktuk_driver";
    const needsLicense = authRole === "car_driver";
    if (!vehMake || !vehColor || (needsExpiry && (!roadWorthyExpiry || !registrationExpiry))) {
      showAlert("Missing details", "Please fill in all required fields.");
      return;
    }
    if (needsLicense && (!licFront || !licBack)) {
      showAlert("Missing details", "Please upload your Driver's License (front and back) — required for car drivers.");
      return;
    }
    let licFrontPath: string | null = null;
    let licBackPath: string | null = null;
    if (needsLicense) {
      licFrontPath = await uploadPrivateDocument(licFront!, "kyc-documents", `${u.id}/license_front.jpg`);
      licBackPath = await uploadPrivateDocument(licBack!, "kyc-documents", `${u.id}/license_back.jpg`);
    }
    await supabase.from("profiles").update({
      vehicle_make: vehMake,
      vehicle_color: vehColor,
      vehicle_plate: vehPlate || null,
      ...(needsExpiry ? { road_worthy_expiry: roadWorthyExpiry, registration_expiry: registrationExpiry } : {}),
      ...(needsLicense ? { kyc_license_front_path: licFrontPath, kyc_license_back_path: licBackPath } : {}),
    }).eq("id", u.id);
    go("pending");
  };

  // Name and phone only — deliberately not email, since that's tied to the
  // actual Supabase Auth login credential and changing it needs a proper
  // re-verification flow, not a quiet field edit that could lock someone
  // out of their own account.
  const saveProfileEdit = async () => {
    if (!editName.trim()) { showAlert("Missing name", "Please enter your name."); return; }
    setSavingProfileEdit(true);
    const { data: { user: u } } = await supabase.auth.getUser();
    if (!u) {
      setSavingProfileEdit(false);
      showAlert("Sign in required", "Profile editing needs a real account — demo accounts can't save changes.");
      return;
    }
    const { error } = await supabase.from("profiles").update({
      full_name: editName.trim(),
      phone: editPhone.trim() || null,
    }).eq("id", u.id);
    setSavingProfileEdit(false);
    if (error) {
      showAlert("Couldn't save", error.message);
      return;
    }
    setUser((prev: any) => prev ? { ...prev, name: editName.trim(), phone: editPhone.trim() } : prev);
    setCustomAlert({
      title: "Profile Updated",
      message: "Your changes have been saved.",
      icon: "checkmark-circle",
      iconColor: "#2DD4BF",
      buttons: [{ text: "OK", onPress: () => {
        const isDriver = ["car_driver", "tuktuk_driver", "motorbike_rider", "restaurant", "driver", "home_service"].includes(user?.role);
        go(isDriver ? "driverProfile" : "clientProfile");
      } }],
    });
  };

  const startDiditVerification = async () => {
    if (startingDiditVerification) return;
    setStartingDiditVerification(true);
    try {
      const { data: { user: u } } = await supabase.auth.getUser();
      if (!u) {
        showAlert("Sign in required", "Instant verification needs a real account — demo accounts can't use this.");
        setStartingDiditVerification(false);
        return;
      }
      const res = await fetch(CREATE_KYC_SESSION_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: u.id }),
      });
      const data = await res.json();
      setStartingDiditVerification(false);
      if (data.sessionUrl) {
        setDiditSessionUrl(data.sessionUrl);
        setShowDiditWebView(true);
      } else {
        console.log("create-kyc-session error:", data.error);
        showAlert("Couldn't start verification", data.error ? `${data.error}\n\nPlease try again.` : "Please try again in a moment.");
      }
    } catch (e) {
      setStartingDiditVerification(false);
      showAlert("Couldn't start verification", "Please check your connection and try again.");
    }
  };

  const submitVerify = async () => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const { data: { user: u } } = await supabase.auth.getUser();
    const providerId = u?.id || "00000000-0000-0000-0000-000000000002";

    // ── CAR DRIVER: Ghana Card + License + Road Worthy + Registration + Vehicle Photo + Selfie
    if (authRole === "car_driver") {
      if (!idPhoto) { showAlert("Missing", "Please upload your Ghana Card"); return; }
      if (!licFront || !licBack) { showAlert("Missing", "Please upload your Driver's License (front and back)"); return; }
      if (!vehiclePhoto) { showAlert("Missing", "Please upload a photo of your vehicle"); return; }
      if (!selfiePhoto) { showAlert("Missing", "Please upload a live selfie"); return; }
      if (!vehMake || !vehModel || !vehPlate) { showAlert("Missing", "Please fill all vehicle details"); return; }
      if (!roadWorthyExpiry || !registrationExpiry) { showAlert("Missing", "Please enter Road Worthy and Registration expiry dates"); return; }

      const rwDate = new Date(roadWorthyExpiry);
      const regDate = new Date(registrationExpiry);
      if (isNaN(rwDate.getTime()) || isNaN(regDate.getTime())) { showAlert("Invalid Date", "Please enter valid dates (YYYY-MM-DD)"); return; }
      if (rwDate < today) { showAlert("Rejected", "Your Road Worthy Certificate has expired. Please renew and resubmit."); return; }
      if (regDate < today) { showAlert("Rejected", "Your Vehicle Registration has expired. Please renew and resubmit."); return; }

      setUploadingKycDocs(true);
      const idPhotoPath = await uploadPrivateDocument(idPhoto, "kyc-documents", `${providerId}/ghana_card.jpg`);
      const licFrontPath = await uploadPrivateDocument(licFront, "kyc-documents", `${providerId}/license_front.jpg`);
      const licBackPath = await uploadPrivateDocument(licBack, "kyc-documents", `${providerId}/license_back.jpg`);
      const vehiclePhotoPath = await uploadPrivateDocument(vehiclePhoto, "kyc-documents", `${providerId}/vehicle_photo.jpg`);
      // Also a public copy — a vehicle's exterior isn't sensitive like ID documents,
      // and clients need to actually see it to recognize their ride on arrival.
      const vehiclePhotoPublicUrl = vehiclePhoto ? await uploadImageToStorage(vehiclePhoto, "vehicle-photos", `${providerId}/vehicle.jpg`) : null;
      const selfiePath = await uploadPrivateDocument(selfiePhoto, "kyc-documents", `${providerId}/selfie.jpg`);
      setUploadingKycDocs(false);

      await supabase.from("profiles").update({
        is_verified: false, kyc_submitted: true, vehicle_make: vehMake, vehicle_model: vehModel,
        vehicle_year: vehYear, vehicle_plate: vehPlate, vehicle_color: vehColor,
        road_worthy_expiry: roadWorthyExpiry, registration_expiry: registrationExpiry,
        kyc_id_photo_path: idPhotoPath, kyc_license_front_path: licFrontPath, kyc_license_back_path: licBackPath,
        kyc_vehicle_photo_path: vehiclePhotoPath, kyc_selfie_path: selfiePath,
        vehicle_photo_url: vehiclePhotoPublicUrl,
      }).eq("id", providerId);
    }

    // ── TUK TUK: Ghana Card + Road Worthy + Registration + Vehicle Photo + Selfie (NO license)
    else if (authRole === "tuktuk_driver") {
      if (!idPhoto) { showAlert("Missing", "Please upload your Ghana Card"); return; }
      if (!vehiclePhoto) { showAlert("Missing", "Please upload a photo of your Tuk Tuk"); return; }
      if (!selfiePhoto) { showAlert("Missing", "Please upload a live selfie"); return; }
      if (!vehMake || !vehPlate) { showAlert("Missing", "Please fill your Tuk Tuk details"); return; }
      if (!roadWorthyExpiry || !registrationExpiry) { showAlert("Missing", "Please enter Road Worthy and Registration expiry dates"); return; }

      const rwDate = new Date(roadWorthyExpiry);
      const regDate = new Date(registrationExpiry);
      if (isNaN(rwDate.getTime()) || isNaN(regDate.getTime())) { showAlert("Invalid Date", "Please enter valid dates (YYYY-MM-DD)"); return; }
      if (rwDate < today) { showAlert("Rejected", "Your Road Worthy Certificate has expired. Please renew and resubmit."); return; }
      if (regDate < today) { showAlert("Rejected", "Your Vehicle Registration has expired. Please renew and resubmit."); return; }

      setUploadingKycDocs(true);
      const idPhotoPath = await uploadPrivateDocument(idPhoto, "kyc-documents", `${providerId}/ghana_card.jpg`);
      const vehiclePhotoPath = await uploadPrivateDocument(vehiclePhoto, "kyc-documents", `${providerId}/vehicle_photo.jpg`);
      const vehiclePhotoPublicUrl = vehiclePhoto ? await uploadImageToStorage(vehiclePhoto, "vehicle-photos", `${providerId}/vehicle.jpg`) : null;
      const selfiePath = await uploadPrivateDocument(selfiePhoto, "kyc-documents", `${providerId}/selfie.jpg`);
      setUploadingKycDocs(false);

      await supabase.from("profiles").update({
        is_verified: false, kyc_submitted: true, vehicle_make: vehMake, vehicle_plate: vehPlate,
        vehicle_color: vehColor,
        road_worthy_expiry: roadWorthyExpiry, registration_expiry: registrationExpiry,
        kyc_id_photo_path: idPhotoPath, kyc_vehicle_photo_path: vehiclePhotoPath, kyc_selfie_path: selfiePath,
        vehicle_photo_url: vehiclePhotoPublicUrl,
      }).eq("id", providerId);
    }

    // ── MOTORBIKE: Ghana Card + Bike Photo + Selfie ONLY (no license, no road worthy, no registration)
    else if (authRole === "motorbike_rider") {
      if (!idPhoto) { showAlert("Missing", "Please upload your Ghana Card"); return; }
      if (!vehiclePhoto) { showAlert("Missing", "Please upload a photo of your bike"); return; }
      if (!selfiePhoto) { showAlert("Missing", "Please upload a live selfie"); return; }
      if (!vehMake || !vehColor) { showAlert("Missing", "Please fill your bike's make and color"); return; }

      setUploadingKycDocs(true);
      const idPhotoPath = await uploadPrivateDocument(idPhoto, "kyc-documents", `${providerId}/ghana_card.jpg`);
      const vehiclePhotoPath = await uploadPrivateDocument(vehiclePhoto, "kyc-documents", `${providerId}/vehicle_photo.jpg`);
      const vehiclePhotoPublicUrl = vehiclePhoto ? await uploadImageToStorage(vehiclePhoto, "vehicle-photos", `${providerId}/vehicle.jpg`) : null;
      const selfiePath = await uploadPrivateDocument(selfiePhoto, "kyc-documents", `${providerId}/selfie.jpg`);
      setUploadingKycDocs(false);

      await supabase.from("profiles").update({
        is_verified: false, kyc_submitted: true, vehicle_make: vehMake, vehicle_color: vehColor, vehicle_plate: vehPlate || null,
        kyc_id_photo_path: idPhotoPath, kyc_vehicle_photo_path: vehiclePhotoPath, kyc_selfie_path: selfiePath,
        vehicle_photo_url: vehiclePhotoPublicUrl,
      }).eq("id", providerId);
    }

    // ── RESTAURANT/VENDOR: Ghana Card + Food Safety Cert + Restaurant Photo (menu handled separately)
    else if (authRole === "restaurant") {
      if (!idPhoto) { showAlert("Missing", "Please upload the owner's Ghana Card"); return; }
      if (!foodSafetyCert) { showAlert("Missing", "Please upload your Food Safety Certificate"); return; }
      if (!restaurantPhoto) { showAlert("Missing", "Please upload a photo of your restaurant or stall"); return; }
      if (!businessName) { showAlert("Missing", "Please enter your business name"); return; }

      setUploadingKycDocs(true);
      const idPhotoPath = await uploadPrivateDocument(idPhoto, "kyc-documents", `${providerId}/ghana_card.jpg`);
      const foodSafetyCertPath = await uploadPrivateDocument(foodSafetyCert, "kyc-documents", `${providerId}/food_safety_cert.jpg`);

      await supabase.from("profiles").update({
        is_verified: false, kyc_submitted: true, full_name: businessName,
        kyc_id_photo_path: idPhotoPath, kyc_food_safety_cert_path: foodSafetyCertPath,
      }).eq("id", providerId);

      // Upload the restaurant photo for real (previously only lived in local device memory)
      const photoUrl = await uploadImageToStorage(restaurantPhoto, "restaurant-photos", `${providerId}/cover.jpg`);
      setUploadingKycDocs(false);

      // Create the restaurant's own record — this is what clients will browse once approved.
      // Starts closed/unapproved; admin approval + the owner opening for orders makes it visible.
      await supabase.from("restaurants").upsert({
        owner_id: providerId,
        business_name: businessName,
        restaurant_photo: photoUrl,
        is_approved: false,
        is_open: false,
      }, { onConflict: "owner_id" });
    }

    // Documents submitted — pending manual admin review
    const roleLabel = authRole === "car_driver" ? "Car Driver" : authRole === "tuktuk_driver" ? "Tuk Tuk Rider" : authRole === "motorbike_rider" ? "Motorbike Rider" : "Restaurant/Vendor";
    showAlert(
      "Documents Submitted! 📋",
      `Your ${roleLabel} application is under review. Expired documents are rejected automatically. You'll typically be approved within a few hours.`,
      [{ text: "OK", onPress: () => go("pending") }]
    );
  };

  const openRatingModal = (bookingId: string) => {
    setPendingRatingBookingId(bookingId);
    setSelectedRating(0);
    setRatingComment("");
    setShowRatingModal(true);
  };

  const submitRating = async () => {
    if (!selectedRating || selectedRating === 0) {
      showAlert("Select Stars", "Please select at least 1 star before submitting.");
      return;
    }
    setShowRatingModal(false);
    await rateDriver(pendingRatingBookingId!, selectedRating, ratingComment);

    // Cash rides skip the tip prompt entirely — the driver was already paid
    // directly in person, and tipping is meant to complement a MoMo/Card ride
    // where the driver's payout only lands after the app processes it.
    const { data: booking } = await supabase.from("bookings").select("payment_method").eq("id", pendingRatingBookingId).maybeSingle();
    if (booking?.payment_method !== "cash") {
      setTipBookingId(pendingRatingBookingId);
      setTipAmount(0);
      setShowTipModal(true);
    } else {
      go("myBookings");
    }
    setPendingRatingBookingId(null);
    setRatingComment("");
    setSelectedRating(0);
  };

  const submitTip = () => {
    if (tipAmount > 0 && tipBookingId) {
      setShowTipModal(false);
      setShowTipPaystack(true);
      return;
    }
    setShowTipModal(false);
    setTipBookingId(null);
    setTipAmount(0);
    go("myBookings");
  };

  const handleTipPaystackResult = async (event: any) => {
    try {
      const msg = JSON.parse(event.nativeEvent.data);
      if (msg.type === "success") {
        const res = await fetch(VERIFY_PAYMENT_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ reference: msg.reference, bookingId: tipBookingId, paymentType: "tip" }),
        });
        const data = await res.json();
        setShowTipPaystack(false);
        if (data.verified) {
          haptic("success");
          showAlert("Tip Sent! 🙏", `GHS ${data.amount} sent directly to your driver. 100% goes to them.`);
          if (tipBookingId) {
            const { data: tippedBooking } = await supabase.from("bookings").select("driver_id").eq("id", tipBookingId).maybeSingle();
            if (tippedBooking?.driver_id) await notifyPaymentReceived(tippedBooking.driver_id, data.amount, "a tip");
          }
        } else {
          showAlert("Tip Failed", "We could not verify your tip payment. Your driver was not charged... or credited.");
        }
      } else {
        setShowTipPaystack(false);
      }
    } catch (e) {
      setShowTipPaystack(false);
      showAlert("Tip Failed", "Something went wrong sending your tip.");
    }
    setTipBookingId(null);
    setTipAmount(0);
    go("myBookings");
  };

  // ============================================================
  // PROMO CODES AND REFERRAL SYSTEM
  // ============================================================
  const generateReferralCode = async (name: string): Promise<string> => {
    const clean = (name.replace(/\s/g, "").toUpperCase().substring(0, 4)) || "USER";
    // Try a few random candidates and check each against Supabase for a real collision check
    for (let attempt = 0; attempt < 5; attempt++) {
      const rand = Math.random().toString(36).substring(2, 6).toUpperCase();
      const candidate = `${clean}-${rand}`;
      const { data: existing } = await supabase
        .from("profiles")
        .select("id")
        .eq("referral_code", candidate)
        .maybeSingle();
      if (!existing) return candidate;
    }
    // Extremely unlikely fallback after 5 collisions — longer suffix all but guarantees uniqueness
    const longRand = Math.random().toString(36).substring(2, 8).toUpperCase();
    return `${clean}-${longRand}`;
  };

  const applyPromoCode = async () => {
    if (!promoCode.trim()) { setPromoError("Please enter a code."); return; }
    const code = promoCode.trim().toUpperCase();
    setPromoError("");

    // Check founder code
    if (code === PLATFORM_SETTINGS.founder_code) {
      setPromoApplied({ type: "founder", discount: PLATFORM_SETTINGS.founder_discount, label: `Founder Code — ${PLATFORM_SETTINGS.founder_discount}% off!` });
      return;
    }

    // Check staff code
    if (code === PLATFORM_SETTINGS.staff_code) {
      setPromoApplied({ type: "staff", discount: PLATFORM_SETTINGS.staff_discount, label: `Staff Code — ${PLATFORM_SETTINGS.staff_discount}% discount applied!` });
      return;
    }

    // Check if it's a referral code from another user
    const { data: referrer } = await supabase
      .from("profiles")
      .select("id, full_name, referral_code")
      .eq("referral_code", code)
      .maybeSingle();

    if (referrer) {
      setPromoApplied({ type: "referral", discount: 25, label: `Referral code from ${referrer.full_name} — 25% off!`, referrerId: referrer.id });
      return;
    }

    // Check promo_codes table (admin-generated codes)
    const { data: promo } = await supabase
      .from("promo_codes")
      .select("*")
      .eq("code", code)
      .eq("is_active", true)
      .maybeSingle();

    if (promo) {
      // Check expiry
      if (promo.expires_at && new Date(promo.expires_at) < new Date()) {
        setPromoError("This promo code has expired.");
        return;
      }
      // Check max uses
      if (promo.max_uses > 0 && promo.uses_count >= promo.max_uses) {
        setPromoError("This promo code has reached its maximum uses.");
        return;
      }
      const label = promo.description
        ? `${code} — ${promo.description} (${promo.discount_percent}% off)`
        : `${code} — ${promo.discount_percent}% discount applied!`;
      setPromoApplied({ type: promo.type || "custom", discount: promo.discount_percent, label, promoId: promo.id });
      return;
    }

    setPromoError("Invalid or expired code. Please try again.");
  };

  const removePromo = () => {
    setPromoApplied(null);
    setPromoCode("");
    setPromoError("");
  };

  const calcDiscountedFare = (originalFare: number) => {
    if (!promoApplied) return originalFare;
    if (promoApplied.discount >= 100) return 0;
    return parseFloat((originalFare * (1 - promoApplied.discount / 100)).toFixed(2));
  };

  const handleReferralReward = async (newUserId: string, referrerId: string) => {
    // Give referrer GHS 5 credit after friend's first ride
    const { data: referrerProfile } = await supabase.from("profiles").select("promo_credit").eq("id", referrerId).maybeSingle();
    if (referrerProfile) {
      await supabase.from("profiles").update({
        promo_credit: (referrerProfile.promo_credit || 0) + 5,
      }).eq("id", referrerId);
    }
  };

  const checkAndApplyWelcomeDiscount = async () => {
    const { data: { user: u } } = await supabase.auth.getUser();
    if (!u) return false;
    const { data: profile } = await supabase.from("profiles").select("welcome_discount_used, first_ride_done").eq("id", u.id).maybeSingle();
    if (profile && !profile.welcome_discount_used && !profile.first_ride_done) {
      return true; // Eligible for welcome discount
    }
    return false;
  };

  const markWelcomeDiscountUsed = async () => {
    const { data: { user: u } } = await supabase.auth.getUser();
    if (!u) return;
    await supabase.from("profiles").update({ welcome_discount_used: true, first_ride_done: true }).eq("id", u.id);
  };

  const rateDriver = async (bookingId: string, stars: number, comment: string = "") => {
    const { data: { user: u } } = await supabase.auth.getUser();
    const clientId = u?.id || "00000000-0000-0000-0000-000000000001";

    const booking = clientBookings.find(b => b.id === bookingId);
    if (!booking) return;

    const driverId = booking.driver_id;

    // Save review to Supabase reviews table
    await supabase.from("reviews").insert({
      job_id: bookingId,
      client_id: clientId,
      pro_id: driverId,
      rating: stars,
      comments: comment,
    });

    // Mark booking as rated
    await supabase.from("bookings").update({ rated: true, client_rating: stars }).eq("id", bookingId);
    setClientBookings(prev => prev.map(b => b.id === bookingId ? { ...b, rated: true, rating: stars } : b));

    // Calculate new driver average rating
    if (driverId) {
      const { data: reviews } = await supabase
        .from("reviews")
        .select("rating")
        .eq("pro_id", driverId);

      if (reviews && reviews.length > 0) {
        const avg = reviews.reduce((s: number, r: any) => s + r.rating, 0) / reviews.length;
        const avgRounded = parseFloat(avg.toFixed(2));

        let updateData: any = { average_rating: avgRounded };

        if (avgRounded < 3.0) {
          updateData.suspended = true;
          updateData.suspension_reason = `Rating dropped below 3.0 (current: ${avgRounded})`;
          updateData.is_verified = false;
        } else if (avgRounded < 3.5) {
          updateData.suspended = true;
          updateData.suspension_reason = `Temporary suspension — low rating (${avgRounded})`;
        } else if (avgRounded < 4.0) {
          updateData.warned = true;
        } else if (avgRounded >= 4.5) {
          updateData.suspended = false;
          updateData.suspension_reason = null;
        }

        await supabase.from("profiles").update(updateData).eq("id", driverId);
      }
    }

    const messages: { [key: number]: string } = {
      5: "Amazing ride! ⭐⭐⭐⭐⭐",
      4: "Great ride! ⭐⭐⭐⭐",
      3: "Thanks for your feedback ⭐⭐⭐",
      2: "Thanks for letting us know.",
      1: "Sorry about that. Your feedback helps us improve.",
    };
    showAlert("Rating Submitted!", messages[stars] || "Thank you!");
    go("myBookings");
  };

  // ============================================================
  // FOOD DELIVERY — RATINGS (separate food quality + rider ratings)
  // ============================================================
  const openFoodRatingModal = (orderId: string) => {
    setPendingFoodRatingOrderId(orderId);
    setSelectedFoodRating(0);
    setSelectedRiderRating(0);
    setShowFoodRatingModal(true);
  };

  const submitFoodRating = async () => {
    if (!selectedFoodRating || !selectedRiderRating) {
      showAlert("Select Stars", "Please rate both the food and your rider before submitting.");
      return;
    }
    const orderId = pendingFoodRatingOrderId;
    setShowFoodRatingModal(false);
    if (!orderId) return;

    const order = foodOrders.find(o => o.id === orderId);
    const riderId = order?.rider_id;

    await supabase.from("food_orders").update({
      food_rating: selectedFoodRating,
      rider_rating: selectedRiderRating,
    }).eq("id", orderId);

    // Rate the rider using the same reviews table and consequence tiers as ride ratings —
    // riders are drivers too, so their reputation should be unified across rides and deliveries.
    if (riderId) {
      await supabase.from("reviews").insert({
        job_id: orderId,
        client_id: order?.client_id,
        pro_id: riderId,
        rating: selectedRiderRating,
        comments: "",
      });

      const { data: reviews } = await supabase.from("reviews").select("rating").eq("pro_id", riderId);
      if (reviews && reviews.length > 0) {
        const avg = reviews.reduce((s: number, r: any) => s + r.rating, 0) / reviews.length;
        const avgRounded = parseFloat(avg.toFixed(2));
        let updateData: any = { average_rating: avgRounded };
        if (avgRounded < 3.0) {
          updateData.suspended = true;
          updateData.suspension_reason = `Rating dropped below 3.0 (current: ${avgRounded})`;
          updateData.is_verified = false;
        } else if (avgRounded < 3.5) {
          updateData.suspended = true;
          updateData.suspension_reason = `Temporary suspension — low rating (${avgRounded})`;
        } else if (avgRounded >= 4.5) {
          updateData.suspended = false;
          updateData.suspension_reason = null;
        }
        await supabase.from("profiles").update(updateData).eq("id", riderId);
      }
    }

    setPendingFoodRatingOrderId(null);
    setSelectedFoodRating(0);
    setSelectedRiderRating(0);
    showAlert("Thanks for rating!", "Your feedback helps keep Luma great.");
    fetchFoodOrders();
  };


  // STYLES
  // ============================================================
  const s = StyleSheet.create({
    safe: { flex: 1, backgroundColor: "#0B1220" },
    center: { flex: 1, backgroundColor: "#0B1220", justifyContent: "center", alignItems: "center", padding: 28 },
    nav: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingHorizontal: 20, paddingVertical: 18, borderBottomWidth: 1, borderBottomColor: "#1B2A44" },
    navLogo: { color: "#F4F6FB", fontSize: 19, fontFamily: "Manrope_700Bold", letterSpacing: 0.3 },
    navLink: { color: "#2DD4BF", fontSize: 14, fontFamily: "Manrope_600SemiBold" },
    title: { color: "#F4F6FB", fontSize: 28, fontFamily: "Manrope_800ExtraBold", marginBottom: 6, letterSpacing: -0.5 },
    input: { backgroundColor: "#131C2E", color: "#F4F6FB", borderRadius: 14, padding: 16, marginBottom: 14, fontSize: 15, borderWidth: 1, borderColor: "#1B2A44" },
    btn: { backgroundColor: "#2DD4BF", borderRadius: 24, padding: 17, alignItems: "center", marginTop: 10, shadowColor: "#2DD4BF", shadowOpacity: 0.28, shadowRadius: 14, shadowOffset: { width: 0, height: 5 }, elevation: 4 },
    btnTxt: { color: "#04231F", fontFamily: "Manrope_800ExtraBold", fontSize: 16, letterSpacing: 0.2 },
    btnOut: { borderWidth: 1.5, borderColor: "#2DD4BF", borderRadius: 24, padding: 16, alignItems: "center", marginTop: 10 },
    btnOutTxt: { color: "#2DD4BF", fontFamily: "Manrope_700Bold", fontSize: 16 },
    btnGreen: { backgroundColor: "#0F2A2270", borderWidth: 1, borderColor: "#2DD4BF", borderRadius: 24, padding: 15, alignItems: "center", marginTop: 10 },
    btnRed: { backgroundColor: "#3A1A1A70", borderWidth: 1, borderColor: "#F87171", borderRadius: 24, padding: 15, alignItems: "center", marginTop: 10 },
    card: { backgroundColor: "#131C2E", borderRadius: 16, padding: 20, marginBottom: 14, borderWidth: 1, borderColor: "#1B2A44", shadowColor: "#000", shadowOpacity: 0.18, shadowRadius: 10, shadowOffset: { width: 0, height: 3 }, elevation: 2 },
    cardTitle: { color: "#F4F6FB", fontSize: 16, fontFamily: "Manrope_700Bold" },
    cardSub: { color: "#8A9BB8", fontSize: 13, marginTop: 3, lineHeight: 18 },
    badge: { paddingHorizontal: 12, paddingVertical: 5, borderRadius: 10, alignSelf: "flex-start", marginTop: 8 },
    sectionTitle: { color: "#8A9BB8", fontSize: 12, fontFamily: "Manrope_700Bold", letterSpacing: 1.5, marginBottom: 12, marginTop: 16, textTransform: "uppercase" },
    row: { flexDirection: "row", gap: 10, marginBottom: 18 },
    statCard: { backgroundColor: "#131C2E", borderRadius: 16, padding: 16, alignItems: "center", flex: 1, borderWidth: 1, borderColor: "#1B2A44", shadowColor: "#000", shadowOpacity: 0.15, shadowRadius: 8, shadowOffset: { width: 0, height: 2 }, elevation: 2 },
    statVal: { color: "#2DD4BF", fontSize: 20, fontFamily: "Manrope_800ExtraBold" },
    statLabel: { color: "#8A9BB8", fontSize: 11, marginTop: 5, letterSpacing: 0.3 },
    roleBtn: { borderRadius: 18, padding: 24, alignItems: "center", marginBottom: 14, borderWidth: 1.5 },
    uploadBox: { backgroundColor: "#131C2E", borderRadius: 16, borderWidth: 1.5, borderColor: "#1B2A44", borderStyle: "dashed", padding: 24, alignItems: "center", marginBottom: 14 },
    uploadImg: { width: "100%", height: 160, borderRadius: 12, resizeMode: "cover" },
    suggestBox: { backgroundColor: "#131C2E", borderRadius: 12, marginBottom: 10, borderWidth: 1, borderColor: "#1B2A44" },
    suggestItem: { padding: 14, borderBottomWidth: 1, borderBottomColor: "#1B2A44" },
    suggestTxt: { color: "#F4F6FB", fontSize: 13 },
    fareBox: { backgroundColor: "#0F2A2260", borderRadius: 16, padding: 16, marginBottom: 10, borderWidth: 1, borderColor: "#2DD4BF" },
    onlineRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", backgroundColor: "#131C2E", borderRadius: 16, padding: 16, marginBottom: 14, borderWidth: 1, borderColor: "#1B2A44" },
    pinRow: { flexDirection: "row", gap: 10, marginBottom: 10 },
    pinBtn: { borderRadius: 12, padding: 12, alignItems: "center", flex: 1 },
    divider: { flexDirection: "row", alignItems: "center", marginVertical: 20 },
    dividerLine: { flex: 1, height: 1, backgroundColor: "#1B2A44" },
    dividerTxt: { color: "#8A9BB8", marginHorizontal: 14, fontSize: 13 },
    verifyStep: { flexDirection: "row", alignItems: "center", backgroundColor: "#131C2E", borderRadius: 16, padding: 16, marginBottom: 12, borderWidth: 1, borderColor: "#1B2A44" },
    verifyNum: { width: 34, height: 34, borderRadius: 17, backgroundColor: "#2DD4BF", alignItems: "center", justifyContent: "center", marginRight: 14 },
    serviceRow: { flexDirection: "row", gap: 10, marginBottom: 14 },
    serviceBtn: { flex: 1, borderRadius: 12, padding: 12, alignItems: "center", borderWidth: 1 },
    chatBubble: { borderRadius: 14, padding: 12, marginBottom: 8, maxWidth: "80%" },
    sosBtn: { backgroundColor: "#3A1A1A70", borderWidth: 1, borderColor: "#F87171", borderRadius: 24, paddingVertical: 12, paddingHorizontal: 16, alignItems: "center", marginTop: 18, alignSelf: "center" },
  });

  // Every hook above this line has now run, in the same order, on every render —
  // safe to bail out here before any screen JSX is returned.
  if (!fontsLoaded) return null;

  // ============================================================
  // SCREENS
  // ============================================================
  // PAYMENT OVERLAY — global, shows immediately wherever it's triggered from
  // (ride fare due, or a cancellation fee), rather than being tied to one screen
  if (showPaystack) return (
    <SafeAreaView style={s.safe}>
      <View style={s.nav}>
        <TouchableOpacity onPress={() => {
          setShowPaystack(false);
          setPendingPaymentBookingId(null);
          setEstFare(null);
        }}><Text style={s.navLink}>Cancel</Text></TouchableOpacity>
        <Text style={s.navLogo}>Secure Payment</Text>
        <View />
      </View>
      <View style={{ padding: 16, backgroundColor: "#131C2E", borderBottomWidth: 1, borderBottomColor: "#1B2A44" }}>
        <Text style={{ color: "#8A9BB8", fontSize: 12 }}>You're paying for</Text>
        <Text style={{ color: "#F4F6FB", fontSize: 16, fontWeight: "700", marginTop: 2 }}>{paymentDescription}</Text>
        <Text style={{ color: "#2DD4BF", fontSize: 22, fontWeight: "bold", marginTop: 4 }}>GHS {(estFare || 20).toFixed(2)}</Text>
        <Text style={{ color: "#5A6B85", fontSize: 11, marginTop: 2 }}>via {paymentMethod === "momo" ? "Mobile Money" : "Card"}</Text>
      </View>
      <WebView
        source={{
          html: `<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><script src="https://js.paystack.co/v1/inline.js"></script></head><body style="margin:0;background:#0B1220;display:flex;align-items:center;justify-content:center;height:100vh;"><script>
            var handler = PaystackPop.setup({
              key: '${PAYSTACK_PUBLIC_KEY}',
              email: '${authEmail}',
              amount: ${Math.round((estFare || 20) * 100)},
              currency: 'GHS',
              channels: ${paymentMethod === "momo" ? "['mobile_money']" : "['card']"},
              callback: function(response){
                window.ReactNativeWebView.postMessage(JSON.stringify({type:'success',reference:response.reference}));
              },
              onClose: function(){
                window.ReactNativeWebView.postMessage(JSON.stringify({type:'cancel'}));
              }
            });
            handler.openIframe();
          </script></body></html>`
        }}
        onMessage={handlePaystackResult}
        style={{ flex: 1 }}
      />
    </SafeAreaView>
  );

  // TIP PAYMENT — separate from the main payment overlay so it can never
  // interfere with ride-fare/cancellation-fee state


  if (showTipPaystack) return (
    <SafeAreaView style={s.safe}>
      <View style={s.nav}>
        <TouchableOpacity onPress={() => {
          setShowTipPaystack(false);
          setTipBookingId(null);
          setTipAmount(0);
          go("myBookings");
        }}><Text style={s.navLink}>Cancel</Text></TouchableOpacity>
        <Text style={s.navLogo}>Send Tip</Text>
        <View />
      </View>
      <View style={{ padding: 16, backgroundColor: "#131C2E", borderBottomWidth: 1, borderBottomColor: "#1B2A44" }}>
        <Text style={{ color: "#8A9BB8", fontSize: 12 }}>Sending a tip to your driver</Text>
        <Text style={{ color: "#2DD4BF", fontSize: 22, fontWeight: "bold", marginTop: 4 }}>GHS {tipAmount.toFixed(2)}</Text>
        <Text style={{ color: "#5A6B85", fontSize: 11, marginTop: 2 }}>100% goes directly to them</Text>
      </View>
      <WebView
        source={{
          html: `<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><script src="https://js.paystack.co/v1/inline.js"></script></head><body style="margin:0;background:#0B1220;display:flex;align-items:center;justify-content:center;height:100vh;"><script>
            var handler = PaystackPop.setup({
              key: '${PAYSTACK_PUBLIC_KEY}',
              email: '${authEmail}',
              amount: ${Math.round(tipAmount * 100)},
              currency: 'GHS',
              channels: ['mobile_money', 'card'],
              callback: function(response){
                window.ReactNativeWebView.postMessage(JSON.stringify({type:'success',reference:response.reference}));
              },
              onClose: function(){
                window.ReactNativeWebView.postMessage(JSON.stringify({type:'cancel'}));
              }
            });
            handler.openIframe();
          </script></body></html>`
        }}
        onMessage={handleTipPaystackResult}
        style={{ flex: 1 }}
      />
    </SafeAreaView>
  );

  // FOOD ORDER PAYMENT — separate overlay, since food orders are a different
  // table entirely from ride bookings
  if (showFoodPaystack) return (
    <SafeAreaView style={s.safe}>
      <View style={s.nav}>
        <TouchableOpacity onPress={() => {
          setShowFoodPaystack(false);
          showAlert("Payment Cancelled", "Your order was saved but not sent to the restaurant. You can retry payment from My Food Orders.");
          setFoodPaymentOrderId(null);
          setFoodPaymentAmount(0);
          go("myFoodOrders");
        }}><Text style={s.navLink}>Cancel</Text></TouchableOpacity>
        <Text style={s.navLogo}>Pay for Order</Text>
        <View />
      </View>
      <View style={{ padding: 16, backgroundColor: "#131C2E", borderBottomWidth: 1, borderBottomColor: "#1B2A44" }}>
        <Text style={{ color: "#8A9BB8", fontSize: 12 }}>You're paying for</Text>
        <Text style={{ color: "#F4F6FB", fontSize: 16, fontWeight: "700", marginTop: 2 }}>Food Order</Text>
        <Text style={{ color: "#2DD4BF", fontSize: 22, fontWeight: "bold", marginTop: 4 }}>GHS {foodPaymentAmount.toFixed(2)}</Text>
        <Text style={{ color: "#5A6B85", fontSize: 11, marginTop: 2 }}>via {foodPaymentMethod === "momo" ? "Mobile Money" : "Card"}</Text>
      </View>
      <WebView
        source={{
          html: `<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><script src="https://js.paystack.co/v1/inline.js"></script></head><body style="margin:0;background:#0B1220;display:flex;align-items:center;justify-content:center;height:100vh;"><script>
            var handler = PaystackPop.setup({
              key: '${PAYSTACK_PUBLIC_KEY}',
              email: '${authEmail}',
              amount: ${Math.round(foodPaymentAmount * 100)},
              currency: 'GHS',
              channels: ${foodPaymentMethod === "momo" ? "['mobile_money']" : "['card']"},
              callback: function(response){
                window.ReactNativeWebView.postMessage(JSON.stringify({type:'success',reference:response.reference}));
              },
              onClose: function(){
                window.ReactNativeWebView.postMessage(JSON.stringify({type:'cancel'}));
              }
            });
            handler.openIframe();
          </script></body></html>`
        }}
        onMessage={handleFoodPaystackResult}
        style={{ flex: 1 }}
      />
    </SafeAreaView>
  );

  // DELIVERY FEE PAYMENT — auto-triggers the moment the rider delivers. Both MoMo
  // and Card are offered directly in Paystack's own modal (no extra pre-selection
  // screen) so paying "on the spot" is as fast as possible.
  if (showDeliveryFeePaystack) return (
    <SafeAreaView style={s.safe}>
      <View style={s.nav}>
        <TouchableOpacity onPress={() => {
          setShowDeliveryFeePaystack(false);
          showAlert("Payment Pending", "You can pay the delivery fee anytime from My Food Orders.");
          setDeliveryFeeOrderId(null);
          setDeliveryFeeAmount(0);
        }}><Text style={s.navLink}>Cancel</Text></TouchableOpacity>
        <Text style={s.navLogo}>Pay Delivery Fee</Text>
        <View />
      </View>
      <View style={{ padding: 20, backgroundColor: "#131C2E" }}>
        <Text style={{ color: "#F4F6FB", fontSize: 15, fontWeight: "700", textAlign: "center" }}>Your order has arrived! 🎉</Text>
        <Text style={{ color: "#8A9BB8", fontSize: 13, textAlign: "center", marginTop: 4 }}>Pay GHS {deliveryFeeAmount.toFixed(2)} to complete your order.</Text>
      </View>
      <WebView
        source={{
          html: `<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><script src="https://js.paystack.co/v1/inline.js"></script></head><body style="margin:0;background:#0B1220;display:flex;align-items:center;justify-content:center;height:100vh;"><script>
            var handler = PaystackPop.setup({
              key: '${PAYSTACK_PUBLIC_KEY}',
              email: '${authEmail}',
              amount: ${Math.round(deliveryFeeAmount * 100)},
              currency: 'GHS',
              channels: ['mobile_money', 'card'],
              callback: function(response){
                window.ReactNativeWebView.postMessage(JSON.stringify({type:'success',reference:response.reference}));
              },
              onClose: function(){
                window.ReactNativeWebView.postMessage(JSON.stringify({type:'cancel'}));
              }
            });
            handler.openIframe();
          </script></body></html>`
        }}
        onMessage={handleDeliveryFeePaystackResult}
        style={{ flex: 1 }}
      />
    </SafeAreaView>
  );

  // FULL-SCREEN MAP VIEWER — in-app only, no external app switch. Uses free
  // OpenStreetMap tiles (no billing needed). Swap for real Google Maps once
  // billing is set up for turn-by-turn directions.
  if (loadingFullMap) return (
    <SafeAreaView style={s.safe}>
      <View style={s.center}><Pulse label="Locating on map..." size={40} /></View>
    </SafeAreaView>
  );

  if (fullMapView) {
    const liveCoord = fullMapView.mode === "driver"
      ? (liveSelfLocation || location)
      : (driverLiveLocation || pickupPin || location);
    const hasLive = !!liveCoord;
    const hasDestination = fullMapView.lat != null && fullMapView.lng != null;
    // Uses the FROZEN coords captured at open time for the initial HTML —
    // NOT the live-updating state — so this html string stays stable across
    // re-renders and the WebView never reloads. Ongoing position updates are
    // handled separately via injectJavaScript (see the useEffect above).
    const liveLat = frozenFullMapCoords?.lat ?? 6.6;
    const liveLng = frozenFullMapCoords?.lng ?? -0.9;
    const liveLabel = fullMapView.mode === "driver" ? "You" : "Your Driver";
    if (!frozenFullMapCoords) return (
      <SafeAreaView style={s.safe}>
        <View style={s.nav}>
          <TouchableOpacity onPress={() => setFullMapView(null)}><Text style={s.navLink}>Close</Text></TouchableOpacity>
          <Text style={s.navLogo}>{fullMapView.label}</Text>
          <View />
        </View>
        <Pulse label="Loading map..." size={32} />
      </SafeAreaView>
    );
    return (
    <SafeAreaView style={s.safe}>
      <View style={s.nav}>
        <TouchableOpacity onPress={() => setFullMapView(null)}><Text style={s.navLink}>Close</Text></TouchableOpacity>
        <Text style={s.navLogo}>{fullMapView.label}</Text>
        <View />
      </View>
      <View style={{ flex: 1 }}>
        <WebView
          ref={fullMapWebViewRef}
          style={{ flex: 1 }}
          source={{
            html: `<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=5,user-scalable=yes"><link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"/><script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script><style>html,body,#map{height:100%;margin:0}.leaflet-popup-content-wrapper{background:#131C2E;color:#F4F6FB;border-radius:10px}.leaflet-popup-tip{background:#131C2E}</style></head><body><div id="map"></div><script>
              var liveLat=${liveLat}, liveLng=${liveLng};
              var liveIcon=L.divIcon({html:'<div style="width:22px;height:22px;background:#2DD4BF;border:3px solid #0B1220;border-radius:50%;box-shadow:0 0 8px rgba(45,212,191,0.7);"></div>',iconSize:[22,22],className:"fp-live"});
              // Draws the real road route via OSRM's free public routing service (no API
              // key needed). Falls back to a straight dashed line if the route request
              // fails — e.g. brief connectivity loss, or the free demo server being busy.
              function lumaDrawRoute(map, fromLat, fromLng, toLat, toLng, color){
                var url = "https://router.project-osrm.org/route/v1/driving/" + fromLng + "," + fromLat + ";" + toLng + "," + toLat + "?overview=full&geometries=geojson";
                fetch(url).then(function(r){ return r.json(); }).then(function(data){
                  if (data && data.routes && data.routes[0] && data.routes[0].geometry) {
                    var coords = data.routes[0].geometry.coordinates.map(function(c){ return [c[1], c[0]]; });
                    // Dark outline drawn first, then a brighter line on top —
                    // gives the route real visual depth/presence against the
                    // map, same technique Google/Apple Maps use, instead of
                    // one flat thin line that blends into the background.
                    L.polyline(coords, {color: "#0B1220", weight: 9, opacity: 0.55, lineJoin: "round", lineCap: "round"}).addTo(map);
                    L.polyline(coords, {color: color, weight: 6, opacity: 1, lineJoin: "round", lineCap: "round"}).addTo(map);
                  } else {
                    L.polyline([[fromLat,fromLng],[toLat,toLng]], {color: "#0B1220", weight: 6, opacity: 0.4, lineCap: "round"}).addTo(map);
                    L.polyline([[fromLat,fromLng],[toLat,toLng]], {color: color, weight: 4, opacity: 0.85, dashArray: "6,8", lineCap: "round"}).addTo(map);
                  }
                }).catch(function(){
                  L.polyline([[fromLat,fromLng],[toLat,toLng]], {color: "#0B1220", weight: 6, opacity: 0.4, lineCap: "round"}).addTo(map);
                  L.polyline([[fromLat,fromLng],[toLat,toLng]], {color: color, weight: 4, opacity: 0.85, dashArray: "6,8", lineCap: "round"}).addTo(map);
                });
              }
              var liveMarker;
              ${hasDestination ? `
              var destLat=${fullMapView.lat}, destLng=${fullMapView.lng};
              var map=L.map("map",{attributionControl:false,zoomControl:true,dragging:true,touchZoom:true,scrollWheelZoom:true,doubleClickZoom:true,boxZoom:true}).fitBounds([[destLat,destLng],[liveLat,liveLng]],{padding:[40,40]});
              L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",{maxZoom:19}).addTo(map);
              lumaDrawRoute(map, liveLat, liveLng, destLat, destLng, "#2DD4BF");
              var destIcon=L.divIcon({html:'<svg width="34" height="42" viewBox="0 0 34 42" xmlns="http://www.w3.org/2000/svg"><path d="M17 0C7.6 0 0 7.6 0 17c0 12 17 25 17 25s17-13 17-25C34 7.6 26.4 0 17 0z" fill="#F5A623"/><circle cx="17" cy="17" r="6" fill="#0B1220"/></svg>',iconSize:[34,42],iconAnchor:[17,42],className:"fp-dest"});
              L.marker([destLat,destLng],{icon:destIcon}).addTo(map).bindPopup(${JSON.stringify(fullMapView.label)});
              liveMarker = L.marker([liveLat,liveLng],{icon:liveIcon}).addTo(map).bindPopup(${JSON.stringify(liveLabel)}).openPopup();
              ` : `
              var map=L.map("map",{attributionControl:false,zoomControl:true,dragging:true,touchZoom:true,scrollWheelZoom:true,doubleClickZoom:true,boxZoom:true}).setView([liveLat,liveLng],15);
              L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",{maxZoom:19}).addTo(map);
              liveMarker = L.marker([liveLat,liveLng],{icon:liveIcon}).addTo(map).bindPopup(${JSON.stringify(liveLabel)}).openPopup();
              `}
              window.lumaMap = map;
              window.lumaRecenter = function(lat,lng){ window.lumaMap.setView([lat,lng], 16); };
              // Moves the marker in place — called from React on every location
              // update, instead of ever reloading this page again.
              window.lumaUpdateLive = function(lat,lng){ if (liveMarker) liveMarker.setLatLng([lat,lng]); };
            </script></body></html>`
          }}
        />
        <TouchableOpacity
          onPress={() => fullMapWebViewRef.current?.injectJavaScript(`window.lumaRecenter && window.lumaRecenter(${liveLat},${liveLng}); true;`)}
          style={{ position: "absolute", bottom: 16, right: 16, backgroundColor: "#2DD4BF", borderRadius: 24, width: 48, height: 48, alignItems: "center", justifyContent: "center", shadowColor: "#000", shadowOpacity: 0.3, shadowRadius: 8, shadowOffset: { width: 0, height: 3 }, elevation: 4 }}>
          <Ionicons name="locate" size={22} color="#04231F" />
        </TouchableOpacity>
      </View>
      <View style={{ padding: 12, backgroundColor: "#131C2E", borderTopWidth: 1, borderTopColor: "#1B2A44" }}>
        {!hasDestination && (
          <Text style={{ color: "#F5A623", textAlign: "center", fontSize: 12, marginBottom: 4 }}>Couldn't pinpoint the exact address — showing your live location only</Text>
        )}
        {fullMapView.mode === "client" && driverEtaMinutes != null && (
          <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "center", marginBottom: 8 }}>
            <View style={{ flexDirection: "row", alignItems: "center", backgroundColor: "#2DD4BF22", borderRadius: 10, paddingVertical: 6, paddingHorizontal: 14 }}>
              <Ionicons name="time" size={16} color="#2DD4BF" />
              <Text style={{ color: "#2DD4BF", fontWeight: "700", marginLeft: 6, fontSize: 14 }}>
                {driverEtaMinutes <= 1 ? "Arriving now" : `${driverEtaMinutes} min away`}
              </Text>
            </View>
          </View>
        )}
        {hasLive
          ? <Text style={{ color: "#2DD4BF", textAlign: "center", fontSize: 12 }}>{"●"} Live — updating every 3 seconds</Text>
          : <Text style={{ color: "#8A9BB8", textAlign: "center", fontSize: 12 }}>Waiting for live location...</Text>
        }
      </View>
    </SafeAreaView>
    );
  }

  // VEHICLE DETAILS — mandatory step after Didit verification for driver
  // roles. Identity is Didit's job; this is purely "what shows up on the
  // client's screen" info, so it doesn't need photos or admin approval.
  // EDIT PROFILE — shared by client and driver. Name/phone only; email isn't
  // editable here since it's the actual login credential.
  if (screen === "editProfile") return (
    <SafeAreaView style={s.safe}>
      <View style={s.nav}>
        <TouchableOpacity onPress={() => {
          const isDriver = ["car_driver", "tuktuk_driver", "motorbike_rider", "restaurant", "driver", "home_service"].includes(user?.role);
          go(isDriver ? "driverProfile" : "clientProfile");
        }}><Text style={s.navLink}>Back</Text></TouchableOpacity>
        <Text style={s.navLogo}>Edit Profile</Text>
        <View />
      </View>
      <ScrollView contentContainerStyle={{ padding: 20 }}>
        <Text style={{ color: "#8A9BB8", fontSize: 12, marginBottom: 6 }}>Full Name</Text>
        <TextInput style={s.input} placeholder="Your name" placeholderTextColor="#5A6B85" value={editName} onChangeText={setEditName} />
        <Text style={{ color: "#8A9BB8", fontSize: 12, marginBottom: 6 }}>Phone Number</Text>
        <TextInput style={s.input} placeholder="Your phone number" placeholderTextColor="#5A6B85" value={editPhone} onChangeText={setEditPhone} keyboardType="phone-pad" />
        <View style={[s.card, { marginTop: 4 }]}>
          <Text style={{ color: "#8A9BB8", fontSize: 12 }}>
            <Ionicons name="mail" size={13} color="#8A9BB8" /> Email: {user?.email}
          </Text>
          <Text style={{ color: "#5A6B85", fontSize: 11, marginTop: 4 }}>Email can't be changed here since it's your login — contact support if you need it updated.</Text>
        </View>
        {savingProfileEdit ? (
          <Pulse label="Saving..." size={28} />
        ) : (
          <TouchableOpacity style={s.btn} onPress={saveProfileEdit}>
            <Text style={s.btnTxt}>Save Changes</Text>
          </TouchableOpacity>
        )}
      </ScrollView>
    </SafeAreaView>
  );

  if (screen === "vehicleDetails") return (
    <SafeAreaView style={s.safe}>
      <View style={s.nav}>
        <View />
        <Text style={s.navLogo}>Vehicle Details</Text>
        <View />
      </View>
      <ScrollView contentContainerStyle={{ padding: 20 }}>
        <Text style={{ color: "#F4F6FB", fontSize: 16, fontWeight: "bold", marginBottom: 4 }}>Almost done!</Text>
        <Text style={{ color: "#8A9BB8", fontSize: 13, marginBottom: 20 }}>
          One last step — tell clients what to look for when you arrive.
        </Text>
        <TextInput
          style={s.input}
          placeholder={authRole === "car_driver" ? "Car Make/Model (e.g. Toyota Corolla)" : authRole === "tuktuk_driver" ? "Tuk Tuk Make/Brand" : "Bike Make/Brand (e.g. Honda)"}
          placeholderTextColor="#5A6B85"
          value={vehMake}
          onChangeText={setVehMake}
        />
        <TextInput
          style={s.input}
          placeholder="Colour (e.g. Silver)"
          placeholderTextColor="#5A6B85"
          value={vehColor}
          onChangeText={setVehColor}
        />
        <TextInput
          style={s.input}
          placeholder={authRole === "motorbike_rider" ? "Plate/Registration Number (optional)" : "Plate Number"}
          placeholderTextColor="#5A6B85"
          value={vehPlate}
          onChangeText={setVehPlate}
          autoCapitalize="characters"
        />
        {(authRole === "car_driver" || authRole === "tuktuk_driver") && (
          <>
            <Text style={{ color: "#2DD4BF", fontSize: 12, marginBottom: 6 }}>Road Worthy Certificate Expiry</Text>
            <TextInput style={s.input} placeholder="YYYY-MM-DD" placeholderTextColor="#5A6B85" value={roadWorthyExpiry} onChangeText={setRoadWorthyExpiry} />
            <Text style={{ color: "#2DD4BF", fontSize: 12, marginBottom: 6 }}>Vehicle Registration Expiry</Text>
            <TextInput style={s.input} placeholder="YYYY-MM-DD" placeholderTextColor="#5A6B85" value={registrationExpiry} onChangeText={setRegistrationExpiry} />
          </>
        )}
        {authRole === "car_driver" && (
          <>
            <Text style={s.sectionTitle}>DRIVER'S LICENSE (REQUIRED)</Text>
            <Text style={{ color: "#8A9BB8", fontSize: 12, marginBottom: 10 }}>
              Didit only verifies who you are — this confirms you're actually licensed to drive.
            </Text>
            <Text style={{ color: "#8A9BB8", marginBottom: 6 }}>Front side:</Text>
            <TouchableOpacity style={s.uploadBox} onPress={() => pickPhoto(setLicFront)}>
              {licFront ? <Image source={{ uri: licFront }} style={s.uploadImg} /> :
                <><Ionicons name="document-text" size={36} color="#2DD4BF" /><Text style={{ color: "#8A9BB8", marginTop: 8 }}>Tap to upload front</Text></>}
            </TouchableOpacity>
            <Text style={{ color: "#8A9BB8", marginBottom: 6 }}>Back side:</Text>
            <TouchableOpacity style={s.uploadBox} onPress={() => pickPhoto(setLicBack)}>
              {licBack ? <Image source={{ uri: licBack }} style={s.uploadImg} /> :
                <><Ionicons name="document-text" size={36} color="#2DD4BF" /><Text style={{ color: "#8A9BB8", marginTop: 8 }}>Tap to upload back</Text></>}
            </TouchableOpacity>
          </>
        )}
        <TouchableOpacity style={s.btn} onPress={submitVehicleDetails}>
          <Text style={s.btnTxt}>Finish</Text>
        </TouchableOpacity>
      </ScrollView>
    </SafeAreaView>
  );

  // DIDIT INSTANT VERIFICATION — hosted flow in a WebView, same pattern as
  // Paystack. Completion isn't detected here (Didit reports the result via
  // webhook, not a postMessage) — closing this just sends the driver to the
  // Pending screen, where "Check Status" will show Approved once the webhook
  // has landed (usually within seconds).
  if (showDiditWebView) return (
    <SafeAreaView style={s.safe}>
      <View style={s.nav}>
        <TouchableOpacity onPress={() => {
          setShowDiditWebView(false);
          setDiditSessionUrl(null);
          // Vehicle info (make/color/plate) was never collected by Didit — it
          // only verifies identity, not what the driver actually drives. This
          // is exactly the gap that left a client-facing driver card with no
          // vehicle details for anyone who used instant verification —
          // routing through this step first closes it for good.
          if (["car_driver", "tuktuk_driver", "motorbike_rider"].includes(authRole || "")) {
            go("vehicleDetails");
          } else {
            go("pending");
          }
        }}><Text style={s.navLink}>Done</Text></TouchableOpacity>
        <Text style={s.navLogo}>Identity Verification</Text>
        <View />
      </View>
      {diditSessionUrl && (
        <WebView
          source={{ uri: diditSessionUrl }}
          style={{ flex: 1 }}
          allowsInlineMediaPlayback={true}
          mediaPlaybackRequiresUserAction={false}
          onPermissionRequest={(event: any) => {
            // Didit's hosted flow needs camera access to capture the selfie
            // and Ghana Card photo. WebViews block camera/mic access by
            // default — without explicitly granting whatever it asks for
            // here, the page loads fine but the camera step silently does
            // nothing, which is exactly what "stuck on Not Started" looks like.
            event.grant(event.resources);
          }}
        />
      )}
    </SafeAreaView>
  );

  // MAINTENANCE MODE — highest priority, blocks the entire app when active
  if (maintenanceMode) return (
    <SafeAreaView style={s.safe}>
      <View style={s.center}>
        <Ionicons name="construct" size={56} color="#2DD4BF" />
        <Text style={{ color: "#F4F6FB", fontSize: 22, fontWeight: "bold", marginTop: 16, marginBottom: 8, textAlign: "center" }}>We'll be right back</Text>
        <Text style={{ color: "#8A9BB8", fontSize: 14, textAlign: "center", lineHeight: 20 }}>
          Luma is undergoing a quick update.{"\n"}Thanks for your patience — we'll be back online shortly.
        </Text>
      </View>
    </SafeAreaView>
  );

  // NEW RIDE ALERT — pops up on top of whatever screen a driver is on (even
  // mid-ride), so they never have to navigate away to see or accept a new
  // request. Dismiss or Accept both return them exactly where they were,
  // since the underlying `screen` state never changes.
  if (incomingRideAlert) return (
    <SafeAreaView style={s.safe}>
      <View style={{ flex: 1, justifyContent: "center", alignItems: "center", padding: 24 }}>
        <View style={{ backgroundColor: "#131C2E", borderRadius: 16, padding: 28, width: "100%", alignItems: "center", borderWidth: 2, borderColor: "#2DD4BF" }}>
          <Ionicons name="notifications" size={40} color="#2DD4BF" />
          <Text style={{ color: "#F4F6FB", fontSize: 20, fontWeight: "bold", marginTop: 8, marginBottom: 4 }}>New Ride Request!</Text>
          <Text style={{ color: "#8A9BB8", fontSize: 13, textAlign: "center", marginBottom: 16 }}>
            {incomingRideAlert.service === "tuktuk" ? "Tuk Tuk" : incomingRideAlert.service === "motorbike" ? "Motorbike" : "Car"} pickup near {incomingRideAlert.pickup?.split(",")[0] || "you"}
          </Text>
          <Text style={{ color: "#2DD4BF", fontSize: 28, fontWeight: "bold", marginBottom: 16 }}>GHS {incomingRideAlert.price}</Text>
          {activeBookingId && (
            <Text style={{ color: "#f5a623", fontSize: 12, textAlign: "center", marginBottom: 12 }}>You're mid-ride — accepting adds this to your queue without interrupting your current trip.</Text>
          )}
          <Tappable
            style={[s.btn, { width: "100%" }]}
            onPress={() => { const ride = incomingRideAlert; dismissRideAlert(); acceptOrder(ride.id); }}>
            <Text style={s.btnTxt}>Accept</Text>
          </Tappable>
          <TouchableOpacity style={{ marginTop: 14 }} onPress={dismissRideAlert}>
            <Text style={{ color: "#5A6B85", fontSize: 13 }}>Dismiss</Text>
          </TouchableOpacity>
        </View>
      </View>
    </SafeAreaView>
  );

  // TIP MODAL — appears after rating, 100% to driver
  if (showTipModal) return (
    <SafeAreaView style={s.safe}>
      <View style={{ flex: 1, justifyContent: "center", alignItems: "center", padding: 24 }}>
        <View style={{ backgroundColor: "#131C2E", borderRadius: 16, padding: 28, width: "100%", alignItems: "center" }}>
          <Text style={{ fontSize: 44, marginBottom: 8 }}><Ionicons name="wallet" size={20} color="#2DD4BF" /></Text>
          <Text style={{ color: "#F4F6FB", fontSize: 20, fontWeight: "bold", textAlign: "center", marginBottom: 4 }}>Leave a Tip?</Text>
          <Text style={{ color: "#8A9BB8", fontSize: 13, textAlign: "center", marginBottom: 8 }}>100% goes directly to your driver.</Text>
          <Text style={{ color: "#5A6B85", fontSize: 11, textAlign: "center", marginBottom: 24 }}>Platform takes nothing from tips — ever.</Text>

          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 10, justifyContent: "center", marginBottom: 20 }}>
            {[2, 5, 10, 15, 20].map(amount => (
              <TouchableOpacity
                key={amount}
                onPress={() => setTipAmount(tipAmount === amount ? 0 : amount)}
                style={{
                  backgroundColor: tipAmount === amount ? "#2DD4BF" : "#1a2a1a",
                  borderWidth: 1,
                  borderColor: tipAmount === amount ? "#2DD4BF" : "#2DD4BF",
                  borderRadius: 10,
                  paddingVertical: 10,
                  paddingHorizontal: 18,
                }}>
                <Text style={{ color: tipAmount === amount ? "#000" : "#2DD4BF", fontWeight: "bold", fontSize: 15 }}>
                  GHS {amount}
                </Text>
              </TouchableOpacity>
            ))}
          </View>

          <TextInput
            style={[s.input, { width: "100%", textAlign: "center" }]}
            placeholder="Or enter custom amount..."
            placeholderTextColor="#5A6B85"
            keyboardType="numeric"
            value={tipAmount > 0 && ![2, 5, 10, 15, 20].includes(tipAmount) ? String(tipAmount) : ""}
            onChangeText={(v) => setTipAmount(parseFloat(v) || 0)}
          />

          {tipAmount > 0 && (
            <Text style={{ color: "#2DD4BF", fontSize: 16, fontWeight: "bold", marginBottom: 12 }}>
              Sending GHS {tipAmount} tip
            </Text>
          )}

          <TouchableOpacity style={[s.btn, { width: "100%", marginTop: 4 }]} onPress={submitTip}>
            <Text style={s.btnTxt}>{tipAmount > 0 ? `Send GHS ${tipAmount} Tip` : "Skip Tip"}</Text>
          </TouchableOpacity>

          <TouchableOpacity style={{ marginTop: 14 }} onPress={() => { setShowTipModal(false); go("myBookings"); }}>
            <Text style={{ color: "#5A6B85", fontSize: 13 }}>No thanks</Text>
          </TouchableOpacity>
        </View>
      </View>
    </SafeAreaView>
  );

  // RATING MODAL — must be checked BEFORE screen renders so it takes priority
  // Branded confirmation modal — replaces plain native Alert.alert popups for
  // the moments that matter most (ride complete, delivery complete), since
  // those can't be restyled and look jarring against the app's dark theme.
  if (customAlert) return (
    <SafeAreaView style={s.safe}>
      <View style={{ flex: 1, justifyContent: "center", alignItems: "center", padding: 24 }}>
        <View style={{ backgroundColor: "#131C2E", borderRadius: 16, padding: 28, width: "100%", alignItems: "center", borderWidth: 1, borderColor: "#2DD4BF33" }}>
          <View style={{ width: 64, height: 64, borderRadius: 32, backgroundColor: `${customAlert.iconColor}22`, alignItems: "center", justifyContent: "center", marginBottom: 16 }}>
            <Ionicons name={customAlert.icon as any} size={32} color={customAlert.iconColor} />
          </View>
          <Text style={{ color: "#F4F6FB", fontSize: 19, fontWeight: "bold", textAlign: "center", marginBottom: 8 }}>{customAlert.title}</Text>
          {!!customAlert.message && (
            <Text style={{ color: "#8A9BB8", fontSize: 14, textAlign: "center", lineHeight: 20, marginBottom: 24 }}>{customAlert.message}</Text>
          )}
          <View style={{ width: "100%", gap: 10 }}>
            {customAlert.buttons.map((btn, i) => {
              const isDestructive = btn.style === "destructive";
              const isCancel = btn.style === "cancel";
              const buttonStyle = isDestructive
                ? [s.btn, { width: "100%", backgroundColor: "#F87171" }]
                : isCancel
                ? [s.btnOut, { width: "100%" }]
                : [s.btn, { width: "100%" }];
              const textStyle = isDestructive
                ? [s.btnTxt, { color: "#fff" }]
                : isCancel
                ? s.btnOutTxt
                : s.btnTxt;
              return (
                <TouchableOpacity
                  key={i}
                  style={buttonStyle as any}
                  onPress={() => {
                    const onPress = btn.onPress;
                    setCustomAlert(null);
                    if (onPress) onPress();
                  }}>
                  <Text style={textStyle}>{btn.text}</Text>
                </TouchableOpacity>
              );
            })}
          </View>
        </View>
      </View>
    </SafeAreaView>
  );

  if (showRatingModal) {
    const ratedBooking = clientBookings.find(b => b.id === pendingRatingBookingId);
    return (
    <SafeAreaView style={s.safe}>
      <View style={{ flex: 1, justifyContent: "center", alignItems: "center", padding: 24 }}>
        <View style={{ backgroundColor: "#131C2E", borderRadius: 16, padding: 28, width: "100%", alignItems: "center" }}>
          <Ionicons name="car-sport" size={40} color="#2DD4BF" />
          <Text style={{ color: "#F4F6FB", fontSize: 20, fontWeight: "bold", textAlign: "center", marginBottom: 4 }}>How was your ride?</Text>
          {ratedBooking && (
            <View style={{ backgroundColor: "#0B1220", borderRadius: 8, padding: 10, marginBottom: 12, width: "100%" }}>
              <Text style={{ color: "#8A9BB8", fontSize: 12, textAlign: "center" }} numberOfLines={1}>
                {ratedBooking.pickup?.split(",")[0]} → {ratedBooking.dropoff?.split(",")[0]}
              </Text>
              <Text style={{ color: "#5A6B85", fontSize: 11, textAlign: "center", marginTop: 2 }}>
                {ratedBooking.time ? `at ${ratedBooking.time}` : ""} · GHS {ratedBooking.price}
              </Text>
            </View>
          )}
          <Text style={{ color: "#8A9BB8", fontSize: 13, textAlign: "center", marginBottom: 24 }}>Your feedback helps improve our service and keeps drivers accountable.</Text>

          <Text style={{ color: "#2DD4BF", fontSize: 13, fontWeight: "700", marginBottom: 12 }}>TAP TO RATE</Text>
          <View style={{ flexDirection: "row", gap: 12, marginBottom: 24 }}>
            {[1, 2, 3, 4, 5].map(star => (
              <TouchableOpacity key={star} onPress={() => setSelectedRating(star)}>
                <Text style={{ fontSize: 44 }}>{star <= selectedRating ? "⭐" : "☆"}</Text>
              </TouchableOpacity>
            ))}
          </View>

          {selectedRating > 0 && (
            <Text style={{ color: "#2DD4BF", fontSize: 14, fontWeight: "bold", marginBottom: 16 }}>
              {selectedRating === 5 ? "Excellent!" : selectedRating === 4 ? "Great!" : selectedRating === 3 ? "Good" : selectedRating === 2 ? "Fair" : "Poor"}
            </Text>
          )}

          <Text style={{ color: "#8A9BB8", fontSize: 12, alignSelf: "flex-start", marginBottom: 6 }}>Comments (optional)</Text>
          <TextInput
            style={[s.input, { width: "100%", minHeight: 80, textAlignVertical: "top" }]}
            placeholder="Tell us about your experience..."
            placeholderTextColor="#5A6B85"
            value={ratingComment}
            onChangeText={setRatingComment}
            multiline
          />

          <TouchableOpacity
            style={[s.btn, { width: "100%", marginTop: 8, opacity: selectedRating === 0 ? 0.5 : 1 }]}
            onPress={submitRating}>
            <Text style={s.btnTxt}>Submit Rating</Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={[s.btnOut, { width: "100%", marginTop: 10 }]}
            onPress={async () => {
              const { data: booking } = await supabase.from("bookings").select("driver_id").eq("id", pendingRatingBookingId).maybeSingle();
              if (booking?.driver_id) {
                const { data: driverProfile } = await supabase.from("profiles").select("full_name").eq("id", booking.driver_id).maybeSingle();
                addFavouriteDriver(booking.driver_id, driverProfile?.full_name || "Driver");
              } else {
                showAlert("Not Available", "Driver info not found for this ride.");
              }
            }}>
            <Text style={s.btnOutTxt}><Ionicons name="star" size={16} color="#2DD4BF" /> Add Driver to Favourites</Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={{ marginTop: 14 }}
            onPress={() => { setShowRatingModal(false); go("myBookings"); }}>
            <Text style={{ color: "#5A6B85", fontSize: 13 }}>Skip for now</Text>
          </TouchableOpacity>
        </View>
      </View>
    </SafeAreaView>
    );
  }

  // FOOD DELIVERY — RATING MODAL (food quality + rider, separately)
  if (showFoodRatingModal) return (
    <SafeAreaView style={s.safe}>
      <View style={{ flex: 1, justifyContent: "center", alignItems: "center", padding: 24 }}>
        <View style={{ backgroundColor: "#131C2E", borderRadius: 16, padding: 28, width: "100%", alignItems: "center" }}>
          <Ionicons name="fast-food" size={40} color="#2DD4BF" />
          <Text style={{ color: "#F4F6FB", fontSize: 20, fontWeight: "bold", textAlign: "center", marginBottom: 4 }}>How was your order?</Text>
          <Text style={{ color: "#8A9BB8", fontSize: 13, textAlign: "center", marginBottom: 24 }}>Rate the food and your delivery rider separately.</Text>

          <Text style={{ color: "#2DD4BF", fontSize: 13, fontWeight: "700", marginBottom: 10 }}>FOOD QUALITY</Text>
          <View style={{ flexDirection: "row", gap: 10, marginBottom: 20 }}>
            {[1, 2, 3, 4, 5].map(star => (
              <TouchableOpacity key={star} onPress={() => setSelectedFoodRating(star)}>
                <Text style={{ fontSize: 36 }}>{star <= selectedFoodRating ? "⭐" : "☆"}</Text>
              </TouchableOpacity>
            ))}
          </View>

          <Text style={{ color: "#2DD4BF", fontSize: 13, fontWeight: "700", marginBottom: 10 }}>YOUR RIDER</Text>
          <View style={{ flexDirection: "row", gap: 10, marginBottom: 24 }}>
            {[1, 2, 3, 4, 5].map(star => (
              <TouchableOpacity key={star} onPress={() => setSelectedRiderRating(star)}>
                <Text style={{ fontSize: 36 }}>{star <= selectedRiderRating ? "⭐" : "☆"}</Text>
              </TouchableOpacity>
            ))}
          </View>

          <TouchableOpacity
            style={[s.btn, { width: "100%", opacity: (selectedFoodRating === 0 || selectedRiderRating === 0) ? 0.5 : 1 }]}
            onPress={submitFoodRating}>
            <Text style={s.btnTxt}>Submit Rating</Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={{ marginTop: 14 }}
            onPress={() => { setShowFoodRatingModal(false); go("myFoodOrders"); }}>
            <Text style={{ color: "#5A6B85", fontSize: 13 }}>Skip for now</Text>
          </TouchableOpacity>
        </View>
      </View>
    </SafeAreaView>
  );

  // WITHDRAWAL MODAL — real Paystack Mobile Money transfer
  if (showWithdrawModal) return (
    <SafeAreaView style={s.safe}>
      <View style={{ flex: 1, justifyContent: "center", padding: 24 }}>
        <View style={{ backgroundColor: "#131C2E", borderRadius: 16, padding: 24 }}>
          <Text style={{ color: "#F4F6FB", fontSize: 18, fontWeight: "bold", marginBottom: 4 }}>Withdraw to Mobile Money</Text>
          <Text style={{ color: "#8A9BB8", fontSize: 13, marginBottom: 20 }}>
            GHS {Math.min(driverWallet?.balance || 0, 2000)} will be sent to the number below.
          </Text>

          <Text style={s.sectionTitle}>NETWORK</Text>
          <View style={{ flexDirection: "row", gap: 8, marginBottom: 16 }}>
            {[["mtn", "MTN"], ["vodafone", "Vodafone"], ["airteltigo", "AirtelTigo"]].map(([val, label]) => (
              <TouchableOpacity
                key={val}
                style={[s.serviceBtn, { flex: 1, borderColor: withdrawMomoProvider === val ? "#2DD4BF" : "#1B2A44", backgroundColor: withdrawMomoProvider === val ? "#2DD4BF22" : "#0B1220" }]}
                onPress={() => setWithdrawMomoProvider(val)}>
                <Text style={{ color: withdrawMomoProvider === val ? "#2DD4BF" : "#8A9BB8", fontWeight: "600", fontSize: 12 }}>{label}</Text>
              </TouchableOpacity>
            ))}
          </View>

          <Text style={s.sectionTitle}>MOBILE MONEY NUMBER</Text>
          <TextInput
            style={s.input}
            placeholder="e.g. 0551234567"
            placeholderTextColor="#5A6B85"
            value={withdrawMomoNumber}
            onChangeText={setWithdrawMomoNumber}
            keyboardType="phone-pad"
          />

          {processingWithdrawal ? (
            <Pulse label="Sending to Paystack..." size={32} />
          ) : (
            <>
              <TouchableOpacity style={[s.btn, { marginTop: 12 }]} onPress={processWithdrawal}>
                <Text style={s.btnTxt}>Confirm Withdrawal</Text>
              </TouchableOpacity>
              <TouchableOpacity style={{ marginTop: 12, alignItems: "center" }} onPress={() => setShowWithdrawModal(false)}>
                <Text style={{ color: "#5A6B85", fontSize: 13 }}>Cancel</Text>
              </TouchableOpacity>
            </>
          )}
        </View>
      </View>
    </SafeAreaView>
  );

  // WELCOME
  if (screen === "welcome") return (
    <SafeAreaView style={s.safe}>
      <View style={s.center}>
        <View style={{ marginBottom: 4 }}><Wordmark fontSize={34} /></View>
        <Text style={{ color: "#8A9BB8", fontSize: 14, marginBottom: 8, textAlign: "center" }}>Ghana's Own Super App</Text>
        <Text style={{ color: "#5A6B85", fontSize: 12, marginBottom: 40, textAlign: "center" }}>Rides | Delivery | Food</Text>
        <TouchableOpacity style={[s.btn, { width: "100%" }]} onPress={() => { setAuthMode("login"); go("auth"); }}>
          <Text style={s.btnTxt}>Log In</Text>
        </TouchableOpacity>
        <TouchableOpacity style={[s.btnOut, { width: "100%" }]} onPress={() => { setAuthMode("signup"); setAuthRole(null); go("roleSelect"); }}>
          <Text style={s.btnOutTxt}>Create Account</Text>
        </TouchableOpacity>
        <Text style={{ color: "#5A6B85", fontSize: 12, marginTop: 24, textAlign: "center" }}>Demo: driver@demo.com | client@demo.com</Text>
      </View>
    </SafeAreaView>
  );

  // ROLE SELECT
  if (screen === "roleSelect") return (
    <SafeAreaView style={s.safe}>
      <View style={s.nav}>
        <TouchableOpacity onPress={() => go("welcome")}><Text style={s.navLink}>Back</Text></TouchableOpacity>
        <Text style={s.navLogo}>Create Account</Text>
        <View />
      </View>
      <ScrollView contentContainerStyle={{ padding: 24 }}>
        <Text style={[s.title, { textAlign: "center" }]}>I am a...</Text>
        <Text style={{ color: "#8A9BB8", textAlign: "center", marginBottom: 24 }}>Choose your role to get started</Text>

        {[
          { role: "client", iconName: "person", label: "Client", sub: "Book rides, deliveries and food", color: "#5B8FE0" },
          { role: "car_driver", iconName: "car-sport", label: "Car Driver", sub: "Provide point-to-point rides", color: "#2DD4BF" },
          { role: "tuktuk_driver", iconName: "car", label: "Tuk Tuk Rider", sub: "Affordable short distance trips", color: "#2DD4BF" },
          { role: "motorbike_rider", iconName: "bicycle", label: "Motorbike Rider", sub: "Fast parcel and errand delivery", color: "#2DD4BF" },
          { role: "restaurant", iconName: "restaurant", label: "Restaurant / Vendor", sub: "List your food for delivery", color: "#2DD4BF" },
        ].map(({ role, iconName, label, sub, color }) => (
          <TouchableOpacity
            key={role}
            style={[s.roleBtn, { borderColor: authRole === role ? color : "#222", backgroundColor: authRole === role ? color + "22" : "#131C2E", marginBottom: 12 }]}
            onPress={() => setAuthRole(role)}>
            <Ionicons name={iconName as any} size={36} color={authRole === role ? color : "#8A9BB8"} />
            <Text style={{ color: authRole === role ? color : "#F4F6FB", fontSize: 16, fontWeight: "bold", marginTop: 6 }}>{label}</Text>
            <Text style={{ color: "#8A9BB8", fontSize: 12, marginTop: 4, textAlign: "center" }}>{sub}</Text>
          </TouchableOpacity>
        ))}

        {authRole && (
          <TouchableOpacity style={[s.btn, { marginTop: 8 }]} onPress={() => go("auth")}>
            <Text style={s.btnTxt}>Continue</Text>
          </TouchableOpacity>
        )}
      </ScrollView>
    </SafeAreaView>
  );

  // AUTH
  if (screen === "auth") return (
    <SafeAreaView style={s.safe}>
      <View style={s.nav}>
        <TouchableOpacity onPress={() => go(authMode === "login" ? "welcome" : "roleSelect")}><Text style={s.navLink}>Back</Text></TouchableOpacity>
        <Text style={s.navLogo}>{authMode === "login" ? "Log In" : "Sign Up"}</Text>
        <View />
      </View>
      <ScrollView contentContainerStyle={{ padding: 24 }}>
        {authMode === "signup" && (
          <>
            <Text style={s.sectionTitle}>YOUR DETAILS</Text>
            <TextInput style={s.input} placeholder="Full Name" placeholderTextColor="#5A6B85" value={authName} onChangeText={setAuthName} />
            <TextInput style={s.input} placeholder="Phone Number" placeholderTextColor="#5A6B85" value={authPhone} onChangeText={setAuthPhone} keyboardType="phone-pad" />
          </>
        )}
        <Text style={s.sectionTitle}>ACCOUNT</Text>
        <TextInput style={s.input} placeholder="Email Address" placeholderTextColor="#5A6B85" value={authEmail} onChangeText={setAuthEmail} keyboardType="email-address" autoCapitalize="none" />
        <TextInput style={s.input} placeholder="Password" placeholderTextColor="#5A6B85" value={authPass} onChangeText={setAuthPass} secureTextEntry />
        {authMode === "signup" && (
          <TextInput style={s.input} placeholder="Confirm Password" placeholderTextColor="#5A6B85" value={authConfirm} onChangeText={setAuthConfirm} secureTextEntry />
        )}
        {authMode === "signup" && ["car_driver", "tuktuk_driver", "motorbike_rider", "restaurant", "home_service"].includes(authRole || "") && (
          <>
            <Text style={s.sectionTitle}>DRIVER REFERRAL (OPTIONAL)</Text>
            <TextInput
              style={s.input}
              placeholder="Referral code from another driver..."
              placeholderTextColor="#5A6B85"
              value={driverRefCode}
              onChangeText={t => setDriverRefCode(t.toUpperCase())}
              autoCapitalize="characters"
            />
            <Text style={{ color: "#5A6B85", fontSize: 11, marginTop: -8, marginBottom: 8 }}>If a fellow driver referred you, enter their code — they'll earn GHS 15 after your 10th ride.</Text>
          </>
        )}
        <TouchableOpacity style={s.btn} onPress={authMode === "login" ? doLogin : doSignup}>
          <Text style={s.btnTxt}>{authMode === "login" ? "Log In" : "Create Account"}</Text>
        </TouchableOpacity>
        <View style={s.divider}><View style={s.dividerLine} /><Text style={s.dividerTxt}>OR</Text><View style={s.dividerLine} /></View>
        <TouchableOpacity style={s.btnOut} onPress={() => setAuthMode(authMode === "login" ? "signup" : "login")}>
          <Text style={s.btnOutTxt}>{authMode === "login" ? "Create New Account" : "Already have an account? Log In"}</Text>
        </TouchableOpacity>
      </ScrollView>
    </SafeAreaView>
  );

  // DRIVER VERIFICATION
  if (screen === "verify") return (
    <SafeAreaView style={s.safe}>
      <View style={s.nav}>
        <View />
        <Text style={s.navLogo}>
          {authRole === "car_driver" ? "Car Driver Verification" :
           authRole === "tuktuk_driver" ? "Tuk Tuk Verification" :
           authRole === "motorbike_rider" ? "Motorbike Verification" :
           authRole === "restaurant" ? "Restaurant Verification" : "Verification"}
        </Text>
        <TouchableOpacity onPress={logout}><Text style={s.navLink}>Log Out</Text></TouchableOpacity>
      </View>
      <ScrollView contentContainerStyle={{ padding: 20 }}>
        <Text style={{ color: "#F4F6FB", fontSize: 18, fontWeight: "bold", marginBottom: 4 }}>Welcome, {user?.name}!</Text>
        <Text style={{ color: "#8A9BB8", fontSize: 13, marginBottom: 4 }}>
          {authRole === "motorbike_rider"
            ? "Quick 2-step verification — no road worthy or registration required for motorbike riders."
            : "Complete all steps below — approval is instant once everything is submitted."}
        </Text>
        <Text style={{ color: "#5A6B85", fontSize: 11, marginBottom: 20 }}>Expired documents are automatically rejected.</Text>

        {verifyStep === 1 && ["car_driver", "tuktuk_driver", "motorbike_rider"].includes(authRole || "") && (
          <View style={[s.card, { borderColor: "#2DD4BF", borderWidth: 1, marginBottom: 20 }]}>
            <Text style={s.cardTitle}><Ionicons name="flash" size={16} color="#2DD4BF" /> Identity Verification</Text>
            <Text style={[s.cardSub, { marginTop: 4, marginBottom: 12 }]}>
              Verify with a quick selfie and Ghana Card scan — usually done in under a minute, no waiting for manual review.
            </Text>
            {startingDiditVerification ? (
              <Pulse label="Starting verification..." size={28} />
            ) : (
              <TouchableOpacity style={s.btn} onPress={startDiditVerification}>
                <Text style={s.btnTxt}>Verify Instantly</Text>
              </TouchableOpacity>
            )}
          </View>
        )}

        {/* ── STEP 1: GHANA CARD (restaurant only — Didit's identity check above doesn't cover business/food-safety verification, so restaurants still go through manual review) ── */}
        {verifyStep === 1 && authRole === "restaurant" && (
          <>
            <Text style={s.sectionTitle}>STEP 1 — GHANA CARD</Text>
            <View style={s.verifyStep}>
              <View style={s.verifyNum}><Text style={{ color: "#000", fontWeight: "bold" }}>1</Text></View>
              <View>
                <Text style={{ color: "#F4F6FB", fontSize: 15, fontWeight: "600" }}>
                  {authRole === "restaurant" ? "Owner's Ghana Card" : "Ghana Card"}
                </Text>
                <Text style={{ color: "#8A9BB8", fontSize: 12, marginTop: 2 }}>
                  {authRole === "restaurant" ? "Clear photo of the business owner's Ghana Card" : "Clear photo of your Ghana Card (front and back)"}
                </Text>
              </View>
            </View>
            <TouchableOpacity style={s.uploadBox} onPress={() => pickPhoto(setIdPhoto)}>
              {idPhoto ? <Image source={{ uri: idPhoto }} style={s.uploadImg} /> :
                <><Text style={{ fontSize: 40 }}><Ionicons name="card" size={40} color="#2DD4BF" /></Text><Text style={{ color: "#8A9BB8", marginTop: 8 }}>Tap to upload Ghana Card</Text></>}
            </TouchableOpacity>
            {idPhoto && (
              <TouchableOpacity style={s.btn} onPress={() => setVerifyStep(2)}>
                <Text style={s.btnTxt}>
                  {authRole === "car_driver" ? "Next: Driver's License" :
                   authRole === "restaurant" ? "Next: Food Safety Certificate" :
                   "Next: Vehicle/Bike Photo"}
                </Text>
              </TouchableOpacity>
            )}
          </>
        )}

        {/* ── STEP 2: DRIVER'S LICENSE (car driver only) or VEHICLE PHOTO (tuktuk/motorbike) or FOOD SAFETY (restaurant) ── */}
        {verifyStep === 2 && (
          <>
            {authRole === "car_driver" && (
              <>
                <Text style={s.sectionTitle}>STEP 2 — DRIVER'S LICENSE</Text>
                <View style={s.verifyStep}>
                  <View style={s.verifyNum}><Text style={{ color: "#000", fontWeight: "bold" }}>2</Text></View>
                  <View>
                    <Text style={{ color: "#F4F6FB", fontSize: 15, fontWeight: "600" }}>Driver's License</Text>
                    <Text style={{ color: "#8A9BB8", fontSize: 12, marginTop: 2 }}>Upload front and back</Text>
                  </View>
                </View>
                <Text style={{ color: "#8A9BB8", marginBottom: 6 }}>Front side:</Text>
                <TouchableOpacity style={s.uploadBox} onPress={() => pickPhoto(setLicFront)}>
                  {licFront ? <Image source={{ uri: licFront }} style={s.uploadImg} /> :
                    <><Text style={{ fontSize: 36 }}><Ionicons name="document-text" size={36} color="#2DD4BF" /></Text><Text style={{ color: "#8A9BB8", marginTop: 8 }}>Tap to upload front</Text></>}
                </TouchableOpacity>
                <Text style={{ color: "#8A9BB8", marginBottom: 6 }}>Back side:</Text>
                <TouchableOpacity style={s.uploadBox} onPress={() => pickPhoto(setLicBack)}>
                  {licBack ? <Image source={{ uri: licBack }} style={s.uploadImg} /> :
                    <><Text style={{ fontSize: 36 }}><Ionicons name="document-text" size={36} color="#2DD4BF" /></Text><Text style={{ color: "#8A9BB8", marginTop: 8 }}>Tap to upload back</Text></>}
                </TouchableOpacity>
                <View style={{ flexDirection: "row", gap: 8, marginTop: 8 }}>
                  <TouchableOpacity style={[s.btnOut, { flex: 1 }]} onPress={() => setVerifyStep(1)}><Text style={s.btnOutTxt}>Back</Text></TouchableOpacity>
                  {licFront && licBack && <TouchableOpacity style={[s.btn, { flex: 2 }]} onPress={() => setVerifyStep(3)}><Text style={s.btnTxt}>Next: Vehicle Photo</Text></TouchableOpacity>}
                </View>
              </>
            )}

            {(authRole === "tuktuk_driver" || authRole === "motorbike_rider") && (
              <>
                <Text style={s.sectionTitle}>STEP 2 — {authRole === "tuktuk_driver" ? "TUK TUK" : "BIKE"} PHOTO</Text>
                <View style={s.verifyStep}>
                  <View style={s.verifyNum}><Text style={{ color: "#000", fontWeight: "bold" }}>2</Text></View>
                  <View>
                    <Text style={{ color: "#F4F6FB", fontSize: 15, fontWeight: "600" }}>{authRole === "tuktuk_driver" ? "Tuk Tuk Photo" : "Bike Photo"}</Text>
                    <Text style={{ color: "#8A9BB8", fontSize: 12, marginTop: 2 }}>Clear photo showing your {authRole === "tuktuk_driver" ? "tuk tuk" : "bike"}</Text>
                  </View>
                </View>
                <TouchableOpacity style={s.uploadBox} onPress={() => pickPhoto(setVehiclePhoto)}>
                  {vehiclePhoto ? <Image source={{ uri: vehiclePhoto }} style={s.uploadImg} /> :
                    <><Text style={{ fontSize: 36 }}><Ionicons name="camera" size={36} color="#2DD4BF" /></Text><Text style={{ color: "#8A9BB8", marginTop: 8 }}>Tap to upload photo</Text></>}
                </TouchableOpacity>
                <View style={{ flexDirection: "row", gap: 8, marginTop: 8 }}>
                  <TouchableOpacity style={[s.btnOut, { flex: 1 }]} onPress={() => setVerifyStep(1)}><Text style={s.btnOutTxt}>Back</Text></TouchableOpacity>
                  {vehiclePhoto && <TouchableOpacity style={[s.btn, { flex: 2 }]} onPress={() => setVerifyStep(3)}><Text style={s.btnTxt}>Next: Live Selfie</Text></TouchableOpacity>}
                </View>
              </>
            )}

            {authRole === "restaurant" && (
              <>
                <Text style={s.sectionTitle}>STEP 2 — FOOD SAFETY CERTIFICATE</Text>
                <View style={s.verifyStep}>
                  <View style={s.verifyNum}><Text style={{ color: "#000", fontWeight: "bold" }}>2</Text></View>
                  <View>
                    <Text style={{ color: "#F4F6FB", fontSize: 15, fontWeight: "600" }}>Food Safety Certificate</Text>
                    <Text style={{ color: "#8A9BB8", fontSize: 12, marginTop: 2 }}>Proves food is prepared safely</Text>
                  </View>
                </View>
                <TouchableOpacity style={s.uploadBox} onPress={() => pickPhoto(setFoodSafetyCert)}>
                  {foodSafetyCert ? <Image source={{ uri: foodSafetyCert }} style={s.uploadImg} /> :
                    <><Text style={{ fontSize: 36 }}><Ionicons name="clipboard" size={18} color="#2DD4BF" /></Text><Text style={{ color: "#8A9BB8", marginTop: 8 }}>Tap to upload certificate</Text></>}
                </TouchableOpacity>
                <View style={{ flexDirection: "row", gap: 8, marginTop: 8 }}>
                  <TouchableOpacity style={[s.btnOut, { flex: 1 }]} onPress={() => setVerifyStep(1)}><Text style={s.btnOutTxt}>Back</Text></TouchableOpacity>
                  {foodSafetyCert && <TouchableOpacity style={[s.btn, { flex: 2 }]} onPress={() => setVerifyStep(3)}><Text style={s.btnTxt}>Next: Restaurant Photo</Text></TouchableOpacity>}
                </View>
              </>
            )}
          </>
        )}

        {/* ── STEP 3: VEHICLE PHOTO + SELFIE (car driver) / SELFIE (tuktuk/motorbike) / RESTAURANT PHOTO + BUSINESS NAME (restaurant) ── */}
        {verifyStep === 3 && (
          <>
            {authRole === "car_driver" && (
              <>
                <Text style={s.sectionTitle}>STEP 3 — VEHICLE PHOTO & SELFIE</Text>
                <Text style={{ color: "#8A9BB8", marginBottom: 6 }}>Vehicle photo:</Text>
                <TouchableOpacity style={s.uploadBox} onPress={() => pickPhoto(setVehiclePhoto)}>
                  {vehiclePhoto ? <Image source={{ uri: vehiclePhoto }} style={s.uploadImg} /> :
                    <><Ionicons name="car-sport" size={36} color="#2DD4BF" /><Text style={{ color: "#8A9BB8", marginTop: 8 }}>Tap to upload vehicle photo</Text></>}
                </TouchableOpacity>
                <Text style={{ color: "#8A9BB8", marginBottom: 6 }}>Live selfie:</Text>
                <TouchableOpacity style={s.uploadBox} onPress={() => pickPhoto(setSelfiePhoto)}>
                  {selfiePhoto ? <Image source={{ uri: selfiePhoto }} style={s.uploadImg} /> :
                    <><Text style={{ fontSize: 36 }}><Ionicons name="camera-reverse" size={36} color="#2DD4BF" /></Text><Text style={{ color: "#8A9BB8", marginTop: 8 }}>Tap to upload selfie</Text></>}
                </TouchableOpacity>
                {vehiclePhoto && selfiePhoto && <TouchableOpacity style={s.btn} onPress={() => setVerifyStep(4)}><Text style={s.btnTxt}>Next: Vehicle Details</Text></TouchableOpacity>}
                <TouchableOpacity style={[s.btnOut, { marginTop: 8 }]} onPress={() => setVerifyStep(2)}><Text style={s.btnOutTxt}>Back</Text></TouchableOpacity>
              </>
            )}

            {authRole === "tuktuk_driver" && (
              <>
                <Text style={s.sectionTitle}>STEP 3 — LIVE SELFIE & VEHICLE DETAILS</Text>
                <Text style={{ color: "#8A9BB8", marginBottom: 6 }}>Live selfie:</Text>
                <TouchableOpacity style={s.uploadBox} onPress={() => pickPhoto(setSelfiePhoto)}>
                  {selfiePhoto ? <Image source={{ uri: selfiePhoto }} style={s.uploadImg} /> :
                    <><Text style={{ fontSize: 36 }}><Ionicons name="camera-reverse" size={36} color="#2DD4BF" /></Text><Text style={{ color: "#8A9BB8", marginTop: 8 }}>Tap to upload selfie</Text></>}
                </TouchableOpacity>
                {selfiePhoto && (
                  <>
                    <TextInput style={s.input} placeholder="Tuk Tuk Make/Brand" placeholderTextColor="#5A6B85" value={vehMake} onChangeText={setVehMake} />
                    <TextInput style={s.input} placeholder="Plate Number" placeholderTextColor="#5A6B85" value={vehPlate} onChangeText={setVehPlate} autoCapitalize="characters" />
                    <TextInput style={s.input} placeholder="Colour (e.g. Yellow)" placeholderTextColor="#5A6B85" value={vehColor} onChangeText={setVehColor} />
                    <Text style={{ color: "#2DD4BF", fontSize: 12, marginBottom: 6 }}>Road Worthy Certificate Expiry</Text>
                    <TextInput style={s.input} placeholder="YYYY-MM-DD" placeholderTextColor="#5A6B85" value={roadWorthyExpiry} onChangeText={setRoadWorthyExpiry} />
                    <Text style={{ color: "#2DD4BF", fontSize: 12, marginBottom: 6 }}>Vehicle Registration Expiry</Text>
                    <TextInput style={s.input} placeholder="YYYY-MM-DD" placeholderTextColor="#5A6B85" value={registrationExpiry} onChangeText={setRegistrationExpiry} />
                    <Text style={{ color: "#5A6B85", fontSize: 11, marginBottom: 8 }}>Expired documents are automatically rejected.</Text>
                  </>
                )}
                <View style={{ flexDirection: "row", gap: 8, marginTop: 8 }}>
                  <TouchableOpacity style={[s.btnOut, { flex: 1 }]} onPress={() => setVerifyStep(2)}><Text style={s.btnOutTxt}>Back</Text></TouchableOpacity>
                  {selfiePhoto && vehMake && vehPlate && roadWorthyExpiry && registrationExpiry &&
                    (uploadingKycDocs ? <View style={{ flex: 2, alignItems: "center" }}><Pulse label="Uploading documents..." size={28} /></View> : <TouchableOpacity style={[s.btn, { flex: 2 }]} onPress={submitVerify}><Text style={s.btnTxt}>Verify Instantly</Text></TouchableOpacity>)}
                </View>
              </>
            )}

            {authRole === "motorbike_rider" && (
              <>
                <Text style={s.sectionTitle}>STEP 3 — BIKE DETAILS &amp; SELFIE</Text>
                <TextInput style={s.input} placeholder="Bike Make/Brand (e.g. Honda)" placeholderTextColor="#5A6B85" value={vehMake} onChangeText={setVehMake} />
                <TextInput style={s.input} placeholder="Bike Color (e.g. Red)" placeholderTextColor="#5A6B85" value={vehColor} onChangeText={setVehColor} />
                <TextInput style={s.input} placeholder="Plate/Registration Number (optional)" placeholderTextColor="#5A6B85" value={vehPlate} onChangeText={setVehPlate} />
                <Text style={{ color: "#5A6B85", fontSize: 11, marginTop: -8, marginBottom: 12 }}>
                  Helps clients recognize your bike when you arrive.
                </Text>
                <View style={s.verifyStep}>
                  <View style={s.verifyNum}><Text style={{ color: "#000", fontWeight: "bold" }}>3</Text></View>
                  <View>
                    <Text style={{ color: "#F4F6FB", fontSize: 15, fontWeight: "600" }}>Live Selfie</Text>
                    <Text style={{ color: "#8A9BB8", fontSize: 12, marginTop: 2 }}>A clear selfie for identity confirmation</Text>
                  </View>
                </View>
                <TouchableOpacity style={s.uploadBox} onPress={() => pickPhoto(setSelfiePhoto)}>
                  {selfiePhoto ? <Image source={{ uri: selfiePhoto }} style={s.uploadImg} /> :
                    <><Text style={{ fontSize: 36 }}><Ionicons name="camera-reverse" size={36} color="#2DD4BF" /></Text><Text style={{ color: "#8A9BB8", marginTop: 8 }}>Tap to upload selfie</Text></>}
                </TouchableOpacity>
                <View style={{ flexDirection: "row", gap: 8, marginTop: 8 }}>
                  <TouchableOpacity style={[s.btnOut, { flex: 1 }]} onPress={() => setVerifyStep(2)}><Text style={s.btnOutTxt}>Back</Text></TouchableOpacity>
                  {selfiePhoto && vehMake && vehColor && (uploadingKycDocs ? <View style={{ flex: 2, alignItems: "center" }}><Pulse label="Uploading documents..." size={28} /></View> : <TouchableOpacity style={[s.btn, { flex: 2 }]} onPress={submitVerify}><Text style={s.btnTxt}>Verify Instantly</Text></TouchableOpacity>)}
                </View>
              </>
            )}

            {authRole === "restaurant" && (
              <>
                <Text style={s.sectionTitle}>STEP 3 — RESTAURANT DETAILS</Text>
                <TextInput style={s.input} placeholder="Business/Restaurant Name" placeholderTextColor="#5A6B85" value={businessName} onChangeText={setBusinessName} />
                <Text style={{ color: "#8A9BB8", marginBottom: 6 }}>Restaurant or stall photo:</Text>
                <TouchableOpacity style={s.uploadBox} onPress={() => pickPhoto(setRestaurantPhoto)}>
                  {restaurantPhoto ? <Image source={{ uri: restaurantPhoto }} style={s.uploadImg} /> :
                    <><Text style={{ fontSize: 36 }}><Ionicons name="restaurant" size={36} color="#2DD4BF" /></Text><Text style={{ color: "#8A9BB8", marginTop: 8 }}>Tap to upload restaurant photo</Text></>}
                </TouchableOpacity>
                <View style={{ flexDirection: "row", gap: 8, marginTop: 8 }}>
                  <TouchableOpacity style={[s.btnOut, { flex: 1 }]} onPress={() => setVerifyStep(2)}><Text style={s.btnOutTxt}>Back</Text></TouchableOpacity>
                  {restaurantPhoto && businessName && (uploadingKycDocs ? <View style={{ flex: 2, alignItems: "center" }}><Pulse label="Uploading documents..." size={28} /></View> : <TouchableOpacity style={[s.btn, { flex: 2 }]} onPress={submitVerify}><Text style={s.btnTxt}>Verify Instantly</Text></TouchableOpacity>)}
                </View>
              </>
            )}
          </>
        )}

        {/* ── STEP 4: VEHICLE DETAILS (car driver only) ── */}
        {verifyStep === 4 && authRole === "car_driver" && (
          <>
            <Text style={s.sectionTitle}>STEP 4 — VEHICLE DETAILS</Text>
            <TextInput style={s.input} placeholder="Vehicle Make (e.g. Toyota)" placeholderTextColor="#5A6B85" value={vehMake} onChangeText={setVehMake} />
            <TextInput style={s.input} placeholder="Vehicle Model (e.g. Corolla)" placeholderTextColor="#5A6B85" value={vehModel} onChangeText={setVehModel} />
            <TextInput style={s.input} placeholder="Vehicle Colour (e.g. Silver)" placeholderTextColor="#5A6B85" value={vehColor} onChangeText={setVehColor} />
            <TextInput style={s.input} placeholder="Year (e.g. 2020)" placeholderTextColor="#5A6B85" value={vehYear} onChangeText={setVehYear} keyboardType="numeric" />
            <TextInput style={s.input} placeholder="Plate Number" placeholderTextColor="#5A6B85" value={vehPlate} onChangeText={setVehPlate} autoCapitalize="characters" />
            <Text style={{ color: "#2DD4BF", fontSize: 12, marginBottom: 6, marginTop: 4 }}>Road Worthy Certificate Expiry</Text>
            <TextInput style={s.input} placeholder="YYYY-MM-DD (e.g. 2027-03-15)" placeholderTextColor="#5A6B85" value={roadWorthyExpiry} onChangeText={setRoadWorthyExpiry} />
            <Text style={{ color: "#2DD4BF", fontSize: 12, marginBottom: 6 }}>Vehicle Registration Expiry</Text>
            <TextInput style={s.input} placeholder="YYYY-MM-DD (e.g. 2027-03-15)" placeholderTextColor="#5A6B85" value={registrationExpiry} onChangeText={setRegistrationExpiry} />
            <Text style={{ color: "#5A6B85", fontSize: 11, marginBottom: 8 }}>Expired documents are automatically rejected.</Text>
            <View style={{ flexDirection: "row", gap: 8, marginTop: 8 }}>
              <TouchableOpacity style={[s.btnOut, { flex: 1 }]} onPress={() => setVerifyStep(3)}><Text style={s.btnOutTxt}>Back</Text></TouchableOpacity>
              {uploadingKycDocs ? <View style={{ flex: 2, alignItems: "center" }}><Pulse label="Uploading documents..." size={28} /></View> : <TouchableOpacity style={[s.btn, { flex: 2 }]} onPress={submitVerify}><Text style={s.btnTxt}>Verify Instantly</Text></TouchableOpacity>}
            </View>
          </>
        )}

      </ScrollView>
    </SafeAreaView>
  );

  // PENDING — under admin review
  if (screen === "confirmEmail") return (
    <SafeAreaView style={s.safe}>
      <View style={s.nav}>
        <Wordmark fontSize={18} />
        <View />
      </View>
      <ScrollView contentContainerStyle={{ flexGrow: 1, alignItems: "center", justifyContent: "center", padding: 24 }}>
        <Ionicons name="mail-unread" size={40} color="#2DD4BF" />
        <Text style={{ color: "#F4F6FB", fontSize: 20, fontWeight: "bold", textAlign: "center", marginTop: 16, marginBottom: 8 }}>Enter your code</Text>
        <Text style={{ color: "#8A9BB8", fontSize: 14, textAlign: "center", marginBottom: 4 }}>
          We sent a confirmation code to{"\n"}<Text style={{ color: "#2DD4BF" }}>{authEmail}</Text>
        </Text>
        <Text style={{ color: "#5A6B85", fontSize: 12, textAlign: "center", marginBottom: 20 }}>
          Check your inbox (and spam folder), then enter the code below.
        </Text>
        <TextInput
          style={[s.input, { width: "100%", textAlign: "center", fontSize: 20, letterSpacing: 4 }]}
          placeholder="Enter code"
          placeholderTextColor="#5A6B85"
          keyboardType="number-pad"
          maxLength={8}
          value={emailOtpCode}
          onChangeText={setEmailOtpCode}
        />
        {verifyingCode
          ? <Pulse label="Confirming your account..." size={36} />
          : (
            <TouchableOpacity style={[s.btn, { width: "100%" }]} onPress={verifyEmailCode}>
              <Text style={s.btnTxt}>Verify Code</Text>
            </TouchableOpacity>
          )}
        <TouchableOpacity style={[s.btnOut, { width: "100%" }]} onPress={async () => {
          const { error } = await supabase.auth.resend({ type: "signup", email: authEmail });
          showAlert(error ? "Error" : "Sent!", error ? error.message : "A new code has been sent — check your inbox.");
        }}>
          <Text style={s.btnOutTxt}>Resend Code</Text>
        </TouchableOpacity>
        <TouchableOpacity style={{ marginTop: 16 }} onPress={() => { setEmailOtpCode(""); setAuthMode("login"); go("auth"); }}>
          <Text style={{ color: "#5A6B85", fontSize: 13 }}>Back to Log In</Text>
        </TouchableOpacity>
      </ScrollView>
    </SafeAreaView>
  );

  if (screen === "pending") return (
    <SafeAreaView style={s.safe}>
      <View style={s.nav}>
        <Wordmark fontSize={18} />
        <TouchableOpacity onPress={logout}><Text style={s.navLink}>Log Out</Text></TouchableOpacity>
      </View>
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: 24 }}>
        <Text style={{ fontSize: 40, marginBottom: 16 }}>{"⏳"}</Text>
        <Text style={{ color: "#F4F6FB", fontSize: 20, fontWeight: "bold", textAlign: "center", marginBottom: 8 }}>Application Under Review</Text>
        <Text style={{ color: "#8A9BB8", fontSize: 14, textAlign: "center", marginBottom: 8 }}>Our team is reviewing your documents. Most applications are approved within a few hours.</Text>
        <Text style={{ color: "#5A6B85", fontSize: 12, textAlign: "center", marginBottom: 24 }}>You'll get access automatically once approved.</Text>
        <TouchableOpacity style={s.btn} onPress={async () => {
          const { data: { user: u } } = await supabase.auth.getUser();
          if (!u) return;
          const { data: profile } = await supabase.from("profiles").select("is_verified, suspended, suspension_reason, role").eq("id", u.id).maybeSingle();
          if (profile?.is_verified) {
            setUser((prev: any) => ({ ...prev, verified: true }));
            showAlert("Approved! ✅", "Welcome to Luma! You can start receiving rides now.", [{ text: "Let's Go!", onPress: () => go(profile.role === "restaurant" ? "restaurantHome" : "driverHome") }]);
          } else if (profile?.suspended) {
            showAlert("Application Rejected", profile.suspension_reason || "Please contact support for details.");
          } else {
            showAlert("Still Under Review", "Your application hasn't been reviewed yet. Please check back soon.");
          }
        }}>
          <Text style={s.btnTxt}><Ionicons name="refresh" size={16} color="#2DD4BF" /> Check Status</Text>
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  );

  // RESTAURANT HOME
  if (screen === "restaurantHome") return (
    <SafeAreaView style={s.safe}>
      <View style={s.nav}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}><Wordmark fontSize={18} /><Text style={{ color: "#8A9BB8", fontSize: 14, fontWeight: "600" }}>Restaurant</Text></View>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 16 }}>
          <TouchableOpacity onPress={() => go("notifications")} style={{ position: "relative" }}>
            <Ionicons name="notifications-outline" size={22} color="#2DD4BF" />
            {unreadCount > 0 && (
              <View style={{ position: "absolute", top: -4, right: -6, backgroundColor: "#F87171", borderRadius: 8, minWidth: 16, height: 16, alignItems: "center", justifyContent: "center", paddingHorizontal: 3 }}>
                <Text style={{ color: "#fff", fontSize: 10, fontWeight: "700" }}>{unreadCount > 9 ? "9+" : unreadCount}</Text>
              </View>
            )}
          </TouchableOpacity>
          <TouchableOpacity onPress={() => go("driverProfile")}><Text style={s.navLink}><Ionicons name="person" size={16} color="#2DD4BF" /> Profile</Text></TouchableOpacity>
        </View>
      </View>
      <ScrollView contentContainerStyle={{ padding: 20 }}>
        <Text style={{ color: "#F4F6FB", fontSize: 18, fontWeight: "bold", marginBottom: 4 }}>{myRestaurant?.business_name || "Your Restaurant"}</Text>
        <Text style={{ color: "#8A9BB8", fontSize: 13, marginBottom: 16 }}>
          {myRestaurant?.is_approved ? "Manage your menu and orders" : "Your application is under review — you'll be notified once approved"}
        </Text>

        {birthdayMode && (
          <View style={{ backgroundColor: "#2a1f0a", borderWidth: 1, borderColor: "#c9a84c", borderRadius: 12, padding: 14, marginBottom: 16 }}>
            <Text style={{ color: "#c9a84c", fontWeight: "bold", fontSize: 15 }}>🎂 It's the founder's birthday!</Text>
          </View>
        )}

        <View style={s.onlineRow}>
          <View>
            <Text style={{ color: "#F4F6FB", fontWeight: "bold" }}>Status</Text>
            <Text style={{ color: myRestaurant?.is_open ? "#2DD4BF" : "#8A9BB8", fontSize: 13 }}>{myRestaurant?.is_open ? "Open — Receiving Orders" : "Closed"}</Text>
          </View>
          <Switch
            value={!!myRestaurant?.is_open}
            onValueChange={toggleRestaurantOpen}
            trackColor={{ false: "#333", true: "#2DD4BF" }}
            thumbColor="#F4F6FB"
            disabled={!myRestaurant?.is_approved}
          />
        </View>

        <Text style={s.sectionTitle}>QUICK ACTIONS</Text>
        <Tappable onPress={() => go("menuManagement")} style={[s.card, { flexDirection: "row", alignItems: "center" }]}>
          <View style={{ width: 52, height: 52, borderRadius: 26, backgroundColor: "#2DD4BF22", alignItems: "center", justifyContent: "center", marginRight: 16 }}>
            <Ionicons name="restaurant" size={26} color="#2DD4BF" />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={s.cardTitle}>My Menu</Text>
            <Text style={s.cardSub}>{menuItems.length} item{menuItems.length === 1 ? "" : "s"} — add, edit, or remove dishes</Text>
          </View>
          <Ionicons name="chevron-forward" size={20} color="#2DD4BF" />
        </Tappable>
        <Tappable onPress={() => go("restaurantIncomingOrders")} style={[s.card, { flexDirection: "row", alignItems: "center" }]}>
          <View style={{ width: 52, height: 52, borderRadius: 26, backgroundColor: "#F5A62322", alignItems: "center", justifyContent: "center", marginRight: 16 }}>
            <Ionicons name="receipt" size={26} color="#F5A623" />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={s.cardTitle}>Incoming Orders</Text>
            <Text style={s.cardSub}>See and accept new food orders</Text>
          </View>
          <Ionicons name="chevron-forward" size={20} color="#F5A623" />
        </Tappable>
        <Tappable onPress={() => go("driverEarnings")} style={[s.card, { flexDirection: "row", alignItems: "center" }]}>
          <View style={{ width: 52, height: 52, borderRadius: 26, backgroundColor: "#2DD4BF22", alignItems: "center", justifyContent: "center", marginRight: 16 }}>
            <Ionicons name="wallet" size={26} color="#2DD4BF" />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={s.cardTitle}>My Earnings</Text>
            <Text style={s.cardSub}>View your earnings and withdraw anytime</Text>
          </View>
          <Ionicons name="chevron-forward" size={20} color="#2DD4BF" />
        </Tappable>
      </ScrollView>
    </SafeAreaView>
  );

  // MENU MANAGEMENT
  if (screen === "menuManagement") return (
    <SafeAreaView style={s.safe}>
      <View style={s.nav}>
        <TouchableOpacity onPress={() => go("restaurantHome")}><Text style={s.navLink}>Back</Text></TouchableOpacity>
        <Text style={s.navLogo}>My Menu</Text>
        <View />
      </View>
      <ScrollView contentContainerStyle={{ padding: 20 }}>
        <Text style={s.sectionTitle}>YOUR DISHES</Text>
        {menuItems.length === 0 ? (
          <EmptyState icon="restaurant-outline" title="No dishes yet" subtitle="Add your first dish below — a photo, name, and price is all it takes to go live." />
        ) : (
          menuItems.map((item) => (
            <View key={item.id} style={[s.card, { flexDirection: "row", alignItems: "center", opacity: item.is_available ? 1 : 0.5 }]}>
              <Image source={{ uri: item.photo_url }} style={{ width: 56, height: 56, borderRadius: 10, marginRight: 14 }} />
              <View style={{ flex: 1 }}>
                <Text style={s.cardTitle}>{item.name}</Text>
                <Text style={s.cardSub}>GHS {item.price}{item.category ? ` — ${item.category}` : ""}</Text>
              </View>
              <TouchableOpacity onPress={() => toggleMenuItemAvailable(item)} style={{ marginRight: 12 }}>
                <Ionicons name={item.is_available ? "eye" : "eye-off"} size={22} color={item.is_available ? "#2DD4BF" : "#5A6B85"} />
              </TouchableOpacity>
              <TouchableOpacity onPress={() => deleteMenuItem(item)}>
                <Ionicons name="trash-outline" size={20} color="#F87171" />
              </TouchableOpacity>
            </View>
          ))
        )}

        <Text style={s.sectionTitle}>ADD A DISH</Text>
        <TouchableOpacity style={s.uploadBox} onPress={pickMenuItemPhoto}>
          {newItemPhoto ? <Image source={{ uri: newItemPhoto }} style={s.uploadImg} /> :
            <><Ionicons name="camera" size={36} color="#2DD4BF" /><Text style={{ color: "#8A9BB8", marginTop: 8 }}>Tap to add a photo (required)</Text></>}
        </TouchableOpacity>
        <TextInput style={s.input} placeholder="Dish name" placeholderTextColor="#5A6B85" value={newItemName} onChangeText={setNewItemName} />
        <TextInput style={s.input} placeholder="Description (optional)" placeholderTextColor="#5A6B85" value={newItemDesc} onChangeText={setNewItemDesc} />
        <TextInput style={s.input} placeholder="Price (GHS)" placeholderTextColor="#5A6B85" value={newItemPrice} onChangeText={setNewItemPrice} keyboardType="numeric" />
        <TextInput style={s.input} placeholder="Category (optional, e.g. Rice, Drinks)" placeholderTextColor="#5A6B85" value={newItemCategory} onChangeText={setNewItemCategory} />
        {uploadingMenuItem ? (
          <Pulse label="Adding dish..." size={32} />
        ) : (
          <TouchableOpacity style={s.btn} onPress={addMenuItem}>
            <Text style={s.btnTxt}>Add to Menu</Text>
          </TouchableOpacity>
        )}
      </ScrollView>
    </SafeAreaView>
  );

  // RESTAURANT INCOMING ORDERS
  if (screen === "restaurantIncomingOrders") {
    const activeStatuses = ["pending", "preparing", "ready_for_pickup", "rider_assigned", "picked_up"];
    const activeOrders = incomingFoodOrders.filter(o => activeStatuses.includes(o.status));
    const historyOrders = incomingFoodOrders.filter(o => !activeStatuses.includes(o.status));
    const shownOrders = showFoodHistory ? historyOrders : activeOrders;
    return (
    <SafeAreaView style={s.safe}>
      <View style={s.nav}>
        <TouchableOpacity onPress={() => go("restaurantHome")}><Text style={s.navLink}>Back</Text></TouchableOpacity>
        <Text style={s.navLogo}>{showFoodHistory ? "Order History" : "Incoming Orders"}</Text>
        <View />
      </View>
      <View style={{ flexDirection: "row", paddingHorizontal: 20, paddingTop: 16, gap: 8 }}>
        <TouchableOpacity
          onPress={() => setShowFoodHistory(false)}
          style={{ flex: 1, paddingVertical: 10, borderRadius: 8, alignItems: "center", backgroundColor: !showFoodHistory ? "#2DD4BF" : "#131C2E", borderWidth: 1, borderColor: !showFoodHistory ? "#2DD4BF" : "#333" }}>
          <Text style={{ color: !showFoodHistory ? "#000" : "#F4F6FB", fontWeight: "700", fontSize: 13 }}>Active ({activeOrders.length})</Text>
        </TouchableOpacity>
        <TouchableOpacity
          onPress={() => setShowFoodHistory(true)}
          style={{ flex: 1, paddingVertical: 10, borderRadius: 8, alignItems: "center", backgroundColor: showFoodHistory ? "#2DD4BF" : "#131C2E", borderWidth: 1, borderColor: showFoodHistory ? "#2DD4BF" : "#333" }}>
          <Text style={{ color: showFoodHistory ? "#000" : "#F4F6FB", fontWeight: "700", fontSize: 13 }}>History ({historyOrders.length})</Text>
        </TouchableOpacity>
      </View>
      <ScrollView contentContainerStyle={{ padding: 20 }}>
        {shownOrders.length === 0 ? (
          <EmptyState
            icon="receipt-outline"
            title={showFoodHistory ? "No past orders yet" : "No active orders right now"}
            subtitle={showFoodHistory ? "Completed and cancelled orders will show up here." : "New food orders will appear here the moment a client places one."}
          />
        ) : (
          shownOrders.map((order) => (
            <View key={order.id} style={s.card}>
              <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
                <Text style={s.cardTitle}>{order.client_name}</Text>
                <View style={[s.badge, {
                  backgroundColor: order.status === "pending" ? "#F5A62322" : order.status === "preparing" ? "#5B8FE022" : order.status === "ready_for_pickup" ? "#2DD4BF22" : order.status === "delivered" ? "#2DD4BF22" : order.status === "cancelled" ? "#F8717122" : "#8A9BB822"
                }]}>
                  <Text style={{ color: order.status === "pending" ? "#F5A623" : order.status === "preparing" ? "#5B8FE0" : order.status === "ready_for_pickup" ? "#2DD4BF" : order.status === "delivered" ? "#2DD4BF" : order.status === "cancelled" ? "#F87171" : "#8A9BB8", fontSize: 11, fontWeight: "700" }}>
                    {order.status === "pending" ? "NEW" : order.status === "preparing" ? "PREPARING" : order.status === "ready_for_pickup" ? "READY — AWAITING RIDER" : order.status.toUpperCase()}
                  </Text>
                </View>
              </View>
              <Text style={s.cardSub}>Deliver to: {order.delivery_address}</Text>
              <Text style={{ color: "#2DD4BF", fontWeight: "bold", marginTop: 6 }}>GHS {order.total} total ({order.payment})</Text>
              {order.status === "pending" && (
                <TouchableOpacity style={[s.btn, { marginTop: 10 }]} onPress={() => acceptFoodOrder(order.id)}>
                  <Text style={s.btnTxt}>Accept Order</Text>
                </TouchableOpacity>
              )}
              {order.status === "preparing" && (
                <TouchableOpacity style={[s.btn, { marginTop: 10 }]} onPress={() => markFoodOrderReady(order.id)}>
                  <Text style={s.btnTxt}>Mark Ready for Pickup</Text>
                </TouchableOpacity>
              )}
            </View>
          ))
        )}
      </ScrollView>
    </SafeAreaView>
  );
  }

  // DRIVER HOME
  if (screen === "driverHome") return (
    <SafeAreaView style={s.safe}>
      <View style={s.nav}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}><Wordmark fontSize={18} /><Text style={{ color: "#8A9BB8", fontSize: 14, fontWeight: "600" }}>Driver</Text></View>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 16 }}>
          <TouchableOpacity onPress={() => go("notifications")} style={{ position: "relative" }}>
            <Ionicons name="notifications-outline" size={22} color="#2DD4BF" />
            {unreadCount > 0 && (
              <View style={{ position: "absolute", top: -4, right: -6, backgroundColor: "#F87171", borderRadius: 8, minWidth: 16, height: 16, alignItems: "center", justifyContent: "center", paddingHorizontal: 3 }}>
                <Text style={{ color: "#fff", fontSize: 10, fontWeight: "700" }}>{unreadCount > 9 ? "9+" : unreadCount}</Text>
              </View>
            )}
          </TouchableOpacity>
          <TouchableOpacity onPress={() => go("driverProfile")}><Text style={s.navLink}><Ionicons name="person" size={16} color="#2DD4BF" /> Profile</Text></TouchableOpacity>
        </View>
      </View>
      <ScrollView contentContainerStyle={{ padding: 20 }}>
        <Text style={{ color: "#F4F6FB", fontSize: 18, fontWeight: "bold", marginBottom: 4 }}>Welcome, {user?.name}!</Text>
        <Text style={{ color: "#8A9BB8", fontSize: 13, marginBottom: 12 }}>{`Keep ${(100 - PLATFORM_SETTINGS.platform_commission * 100).toFixed(0)}% of every fare + 100% of tips`}</Text>

        {birthdayMode && (
          <View style={{ backgroundColor: "#2a1f0a", borderWidth: 1, borderColor: "#2DD4BF", borderRadius: 12, padding: 14, marginBottom: 16 }}>
            <Text style={{ color: "#2DD4BF", fontWeight: "bold", fontSize: 15 }}>🎂 It's the founder's birthday!</Text>
            <Text style={{ color: "#8A9BB8", fontSize: 12, marginTop: 4 }}>Thanks for being part of the Luma journey.</Text>
          </View>
        )}

        {queuedRides.length === 1 && (
          <TouchableOpacity onPress={() => resumeUnfinishedRide()} style={{ backgroundColor: "#F8717122", borderWidth: 1, borderColor: "#F87171", borderRadius: 12, padding: 14, marginBottom: 16, flexDirection: "row", alignItems: "center" }}>
            <Ionicons name="alert-circle" size={24} color="#F87171" />
            <View style={{ flex: 1, marginLeft: 10 }}>
              <Text style={{ color: "#F87171", fontWeight: "bold", fontSize: 14 }}>You have an unfinished ride</Text>
              <Text style={{ color: "#F4F6FB", fontSize: 12, marginTop: 2 }}>To: {unfinishedRide.dropoff} — tap to resume</Text>
            </View>
            <Ionicons name="chevron-forward" size={20} color="#F87171" />
          </TouchableOpacity>
        )}
        {queuedRides.length > 1 && (
          <View style={{ backgroundColor: "#F8717122", borderWidth: 1, borderColor: "#F87171", borderRadius: 12, padding: 14, marginBottom: 16 }}>
            <Text style={{ color: "#F87171", fontWeight: "bold", fontSize: 14, marginBottom: 10 }}>You have {queuedRides.length} unfinished rides</Text>
            {queuedRides.map((ride, i) => (
              <TouchableOpacity key={ride.id} onPress={() => resumeUnfinishedRide(ride)} style={{ flexDirection: "row", alignItems: "center", paddingVertical: 8, borderTopWidth: i > 0 ? 1 : 0, borderTopColor: "#F8717144" }}>
                <View style={{ flex: 1 }}>
                  <Text style={{ color: "#F4F6FB", fontSize: 13 }}>To: {ride.dropoff}</Text>
                  <Text style={{ color: "#8A9BB8", fontSize: 11 }}>GHS {ride.price}</Text>
                </View>
                <Ionicons name="chevron-forward" size={18} color="#F87171" />
              </TouchableOpacity>
            ))}
          </View>
        )}

        <View style={{ borderRadius: 12, overflow: "hidden", marginBottom: 16, position: "relative" }}>
          <WebView
            style={{ width: "100%", height: 300 }}
            source={{
              html: `<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"/><script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script><style>html,body,#map{height:100%;margin:0}@keyframes pulse{0%{transform:scale(0.6);opacity:0.7}70%{transform:scale(2.4);opacity:0}100%{opacity:0}}.pulse-ring{width:14px;height:14px;border-radius:50%;background:#2DD4BF;animation:pulse 2s ease-out infinite}</style></head><body><div id="map"></div><script>
                var myLat=${location?.latitude || 6.6}, myLng=${location?.longitude || -0.9};
                var map=L.map("map",{zoomControl:true,attributionControl:false,dragging:true,touchZoom:true,scrollWheelZoom:true,doubleClickZoom:true}).setView([myLat,myLng],15);
                L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",{maxZoom:19}).addTo(map);
                var meIcon=L.divIcon({html:'<div style="position:relative;width:38px;height:46px;">${online ? '<div class="pulse-ring" style="position:absolute;left:12px;top:16px;"></div>' : ''}<svg width="38" height="46" viewBox="0 0 38 46" xmlns="http://www.w3.org/2000/svg" style="position:relative;"><path d="M19 0C8.5 0 0 8.5 0 19c0 13.3 19 27 19 27s19-13.7 19-27C38 8.5 29.5 0 19 0z" fill="#0B1220" stroke="#2DD4BF" stroke-width="2"/><path d="M11 22.5l1.3-4c.2-.6.8-1 1.4-1h10.6c.6 0 1.2.4 1.4 1l1.3 4v5.5c0 .4-.3.7-.7.7h-1.6c-.4 0-.7-.3-.7-.7v-1H15v1c0 .4-.3.7-.7.7h-1.6c-.4 0-.7-.3-.7-.7V22.5z" fill="#2DD4BF"/><circle cx="14.5" cy="25.5" r="1.3" fill="#0B1220"/><circle cx="23.5" cy="25.5" r="1.3" fill="#0B1220"/></svg></div>',iconSize:[38,46],iconAnchor:[19,46],className:"me-marker"});
                L.marker([myLat,myLng],{icon:meIcon}).addTo(map);
              </script></body></html>`
            }}
          />
          <TouchableOpacity
            onPress={() => setFullMapView({ lat: null, lng: null, label: "Your Location", mode: "driver" })}
            style={{ position: "absolute", top: 10, right: 10, backgroundColor: "#0B1220E6", borderRadius: 20, width: 40, height: 40, alignItems: "center", justifyContent: "center" }}>
            <Ionicons name="expand" size={18} color="#2DD4BF" />
          </TouchableOpacity>
        </View>

        <View style={s.onlineRow}>
          <View>
            <Text style={{ color: "#F4F6FB", fontWeight: "bold" }}>Status</Text>
            <Text style={{ color: online ? "#2DD4BF" : "#8A9BB8", fontSize: 13 }}>{online ? "Online — Receiving Rides" : "Offline"}</Text>
          </View>
          <Switch value={online} onValueChange={toggleOnline} trackColor={{ false: "#333", true: "#2DD4BF" }} thumbColor="#F4F6FB" />
        </View>

        <View style={s.row}>
          <View style={s.statCard}><Text style={s.statVal}>GHS {driverWallet?.balance?.toFixed(2) || "0.00"}</Text><Text style={s.statLabel}>Wallet</Text></View>
          <View style={s.statCard}><Text style={s.statVal}>{driverBookings.filter(b => b.status === "completed").length}</Text><Text style={s.statLabel}>Rides</Text></View>
          <View style={s.statCard}><Text style={s.statVal}><Ionicons name="star" size={16} color="#2DD4BF" /> {driverRating}</Text><Text style={s.statLabel}>Rating</Text></View>
        </View>

        <Text style={s.sectionTitle}>QUICK ACTIONS</Text>
        <TouchableOpacity style={[s.card, { flexDirection: "row", alignItems: "center" }]} onPress={() => go("clientOrders")}>
          <View style={{ width: 52, height: 52, borderRadius: 26, backgroundColor: "#2DD4BF22", alignItems: "center", justifyContent: "center", marginRight: 16 }}>
            <Ionicons name="clipboard" size={26} color="#2DD4BF" />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={s.cardTitle}>View Incoming Orders</Text>
            <Text style={s.cardSub}>See all ride requests waiting for a driver</Text>
          </View>
          <Ionicons name="chevron-forward" size={20} color="#2DD4BF" />
        </TouchableOpacity>
        {user?.role === "motorbike_rider" && (
          <TouchableOpacity style={[s.card, { flexDirection: "row", alignItems: "center" }]} onPress={() => go("availableFoodDeliveries")}>
            <View style={{ width: 52, height: 52, borderRadius: 26, backgroundColor: "#F5A62322", alignItems: "center", justifyContent: "center", marginRight: 16 }}>
              <Ionicons name="fast-food" size={26} color="#F5A623" />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={s.cardTitle}>Food Deliveries</Text>
              <Text style={s.cardSub}>See restaurant orders ready for pickup</Text>
            </View>
            <Ionicons name="chevron-forward" size={20} color="#F5A623" />
          </TouchableOpacity>
        )}
        <TouchableOpacity style={[s.card, { flexDirection: "row", alignItems: "center" }]} onPress={() => go("driverLostItems")}>
          <View style={{ width: 52, height: 52, borderRadius: 26, backgroundColor: "#5B8FE022", alignItems: "center", justifyContent: "center", marginRight: 16 }}>
            <Ionicons name="search" size={26} color="#5B8FE0" />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={s.cardTitle}>Lost & Found</Text>
            <Text style={s.cardSub}>Items clients reported leaving in your vehicle</Text>
          </View>
          <Ionicons name="chevron-forward" size={20} color="#5B8FE0" />
        </TouchableOpacity>
        <TouchableOpacity style={[s.card, { flexDirection: "row", alignItems: "center" }]} onPress={() => go("driverEarnings")}>
          <View style={{ width: 52, height: 52, borderRadius: 26, backgroundColor: "#2DD4BF22", alignItems: "center", justifyContent: "center", marginRight: 16 }}>
            <Ionicons name="wallet" size={26} color="#2DD4BF" />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={s.cardTitle}>My Earnings</Text>
            <Text style={s.cardSub}>View your earnings and withdraw anytime</Text>
          </View>
          <Ionicons name="chevron-forward" size={20} color="#2DD4BF" />
        </TouchableOpacity>
        <TouchableOpacity style={[s.card, { flexDirection: "row", alignItems: "center" }]} onPress={() => go("driverProfile")}>
          <View style={{ width: 52, height: 52, borderRadius: 26, backgroundColor: "#5B8FE022", alignItems: "center", justifyContent: "center", marginRight: 16 }}>
            <Ionicons name="person" size={26} color="#5B8FE0" />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={s.cardTitle}>My Profile</Text>
            <Text style={s.cardSub}>View and update your driver profile</Text>
          </View>
          <Ionicons name="chevron-forward" size={20} color="#5B8FE0" />
        </TouchableOpacity>
      </ScrollView>
    </SafeAreaView>
  );

  // DRIVER ORDERS
  if (screen === "clientOrders") return (
    <SafeAreaView style={s.safe}>
      <View style={s.nav}>
        <TouchableOpacity onPress={() => go("driverHome")}><Text style={s.navLink}>Back</Text></TouchableOpacity>
        <Text style={s.navLogo}>Incoming Orders</Text>
        <View />
      </View>
      <ScrollView
        contentContainerStyle={{ padding: 20 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => handleRefresh(fetchDriverBookings)} tintColor="#2DD4BF" colors={["#2DD4BF"]} />}>
        {!online
          ? <EmptyState icon="moon-outline" title="You're offline" subtitle="Go online from your home screen to start receiving ride requests. While you're offline, new requests won't come through." />
          : driverBookings.length === 0
          ? <EmptyState icon="car-outline" title="No requests right now" subtitle="Stay online and keep close to busy areas — new ride requests will land here the moment they come in." />
          : driverBookings.map((b, i) => (
            <View key={i} style={[s.card, b.status === "scheduled" && { borderColor: "#5B8FE0", borderWidth: 1 }]}>
              <Text style={s.cardTitle}><Ionicons name={b.status === "scheduled" ? "calendar" : "car-sport"} size={15} color="#F4F6FB" /> {b.status === "scheduled" ? "Scheduled Ride" : "Ride Request"}</Text>
              {b.scheduled_for && (
                <Text style={{ color: "#5B8FE0", fontWeight: "bold", marginTop: 4 }}>
                  <Ionicons name="time" size={13} color="#5B8FE0" /> Pickup: {new Date(b.scheduled_for).toLocaleDateString()} at {new Date(b.scheduled_for).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                </Text>
              )}
              <Text style={{ color: "#8A9BB8", marginTop: 4 }}><Ionicons name="location" size={13} color="#8A9BB8" /> From: {b.pickup}</Text>
              <Text style={{ color: "#8A9BB8" }}><Ionicons name="flag" size={13} color="#8A9BB8" /> To: {b.dropoff}</Text>
              <Text style={{ color: "#2DD4BF", fontWeight: "bold", marginTop: 6 }}>GHS {b.price}</Text>
              <View style={{ flexDirection: "row", gap: 8, marginTop: 8 }}>
                <View style={[s.badge, { backgroundColor: b.status === "pending" ? "#2a2000" : b.status === "scheduled" ? "#0a1a2a" : b.status === "accepted" ? "#1a3a1a" : "#1a1a2a" }]}>
                  <Text style={{ color: b.status === "pending" ? "#f5a623" : b.status === "scheduled" ? "#5B8FE0" : b.status === "accepted" ? "#2DD4BF" : "#8A9BB8", fontSize: 12 }}>{b.status?.toUpperCase()}</Text>
                </View>
              </View>
              {(b.status === "pending" || b.status === "scheduled") && (
                <TouchableOpacity style={[s.btnGreen, { marginTop: 8 }]} onPress={() => acceptOrder(b.id)}>
                  <Text style={{ color: "#2DD4BF", fontWeight: "bold" }}><Ionicons name="checkmark-circle" size={16} color="#2DD4BF" /> Accept {b.status === "scheduled" ? "Scheduled " : ""}Ride</Text>
                </TouchableOpacity>
              )}
              {b.status === "accepted" && (
                <TouchableOpacity style={[s.btn, { marginTop: 8 }]} onPress={() => { setActiveBookingId(b.id); go("activeRide"); }}>
                  <Text style={s.btnTxt}>View Active Ride</Text>
                </TouchableOpacity>
              )}
            </View>
          ))
        }
      </ScrollView>
    </SafeAreaView>
  );

  // ACTIVE RIDE (DRIVER)
  if (screen === "activeRide") {
    const activeOrder = driverBookings.find(b => b.id === activeBookingId);
    return (
    <SafeAreaView style={s.safe}>
      <View style={s.nav}>
        <TouchableOpacity onPress={() => go("clientOrders")}><Text style={s.navLink}>Back</Text></TouchableOpacity>
        <Text style={s.navLogo}>Active Ride</Text>
        <View />
      </View>
      <ScrollView contentContainerStyle={{ padding: 20 }}>
        <View style={s.card}>
          <Text style={s.cardTitle}><Ionicons name="car-sport" size={15} color="#F4F6FB" /> Ride in Progress</Text>
          {activeOrder?.recipient_name ? (
            <View style={{ backgroundColor: "#F5A62322", borderRadius: 8, padding: 10, marginTop: 8, marginBottom: 4 }}>
              <Text style={{ color: "#F5A623", fontWeight: "700", fontSize: 13 }}>
                <Ionicons name="person" size={14} color="#F5A623" /> Picking up: {activeOrder.recipient_name}
              </Text>
              {activeOrder?.recipient_phone && (
                <Text style={{ color: "#F5A623", fontSize: 12, marginTop: 2 }}>{activeOrder.recipient_phone}</Text>
              )}
              <Text style={{ color: "#8A9BB8", fontSize: 11, marginTop: 4 }}>Booked by {activeOrder?.client_name} — not the person you'll be picking up</Text>
            </View>
          ) : null}
          <Text style={{ color: "#8A9BB8", fontSize: 13, marginTop: 4 }}><Ionicons name="location" size={13} color="#8A9BB8" /> Pickup: {activeOrder?.pickup}</Text>
          <Text style={{ color: "#8A9BB8", fontSize: 13 }}><Ionicons name="flag" size={13} color="#8A9BB8" /> Dropoff: {activeOrder?.dropoff}</Text>
          <Text style={{ color: "#2DD4BF", marginTop: 4 }}>Navigate to pickup location</Text>
        </View>

        <Text style={s.sectionTitle}>LIVE MAP</Text>
        <Tappable onPress={() => openFullMap(driverArrivedAt ? activeOrder?.dropoff : activeOrder?.pickup, driverArrivedAt ? "Dropoff" : "Pickup", "driver")} style={{ position: "relative" }}>
          <WebView
            pointerEvents="none"
            style={{ width: "100%", height: 300, borderRadius: 12, marginBottom: 12 }}
            source={{
              html: `<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"/><script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script><style>html,body,#map{height:100%;margin:0}</style></head><body><div id="map"></div><script>
                var myLat=${location?.latitude || 6.6}, myLng=${location?.longitude || -0.9};
                var map=L.map("map",{zoomControl:false,attributionControl:false,dragging:false,scrollWheelZoom:false,doubleClickZoom:false}).setView([myLat,myLng],14);
                L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",{maxZoom:19}).addTo(map);
                var meIcon=L.divIcon({html:'<svg width="34" height="42" viewBox="0 0 34 42" xmlns="http://www.w3.org/2000/svg"><path d="M17 0C7.6 0 0 7.6 0 17c0 12 17 25 17 25s17-13 17-25C34 7.6 26.4 0 17 0z" fill="#2DD4BF"/><circle cx="17" cy="17" r="6" fill="#0B1220"/></svg>',iconSize:[34,42],iconAnchor:[17,42],className:"me-marker"});
                L.marker([myLat,myLng],{icon:meIcon}).addTo(map).bindPopup("You").openPopup();
              </script></body></html>`
            }}
          />
          <View style={{ position: "absolute", bottom: 12, left: 0, right: 0, alignItems: "center" }}>
            <View style={{ flexDirection: "row", alignItems: "center", backgroundColor: "#0B1220E6", paddingVertical: 8, paddingHorizontal: 14, borderRadius: 20 }}>
              <Ionicons name="navigate" size={15} color="#2DD4BF" />
              <Text style={{ color: "#F4F6FB", fontSize: 12, fontWeight: "600", marginLeft: 6 }}>
                Tap to view full map — {driverArrivedAt ? "dropoff" : "pickup"}
              </Text>
            </View>
          </View>
        </Tappable>

        {(() => {
          const lastMsg = chatMessages[chatMessages.length - 1];
          const hasUnread = !!lastMsg && lastMsg.sender_id !== user?.id && lastMsg.id !== lastSeenChatMessageId;
          return (
            <>
              <TouchableOpacity
                onPress={() => { setChatOpen(!chatOpen); if (!chatOpen && lastMsg) setLastSeenChatMessageId(lastMsg.id); }}
                style={[s.card, { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: chatOpen ? 8 : 16 }]}>
                <View style={{ flexDirection: "row", alignItems: "center" }}>
                  <Ionicons name="chatbubble-ellipses" size={18} color="#2DD4BF" />
                  <Text style={{ color: "#F4F6FB", fontWeight: "700", marginLeft: 8 }}>Chat with Client</Text>
                  {hasUnread && <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: "#F87171", marginLeft: 8 }} />}
                </View>
                <Ionicons name={chatOpen ? "chevron-up" : "chevron-down"} size={18} color="#8A9BB8" />
              </TouchableOpacity>
              {chatOpen && (
                <>
                  <View style={{ backgroundColor: "#131C2E", borderRadius: 12, padding: 12, marginBottom: 8, minHeight: 120 }}>
                    {chatMessages.length === 0
                      ? <Text style={{ color: "#5A6B85", textAlign: "center", marginTop: 20 }}>No messages yet — say hello 👋</Text>
                      : chatMessages.map((m, i) => (
                        <View key={i} style={[s.chatBubble, { backgroundColor: m.sender_id === user?.id ? "#2DD4BF22" : "#131C2E", alignSelf: m.sender_id === user?.id ? "flex-end" : "flex-start" }]}>
                          <Text style={{ color: "#8A9BB8", fontSize: 11 }}>{m.sender_name}</Text>
                          {m.image_url
                            ? <Image source={{ uri: m.image_url }} style={{ width: 160, height: 160, borderRadius: 10, marginTop: 4 }} resizeMode="cover" />
                            : <Text style={{ color: "#F4F6FB" }}>{m.message}</Text>}
                        </View>
                      ))
                    }
                  </View>
                  <View style={{ flexDirection: "row", gap: 8, marginBottom: 16 }}>
                    <TouchableOpacity
                      style={{ width: 44, height: 44, borderRadius: 22, backgroundColor: "#131C2E", borderWidth: 1, borderColor: "#1B2A44", alignItems: "center", justifyContent: "center" }}
                      disabled={uploadingChatPhoto}
                      onPress={() => activeBookingId && sendChatPhoto(activeBookingId)}>
                      {uploadingChatPhoto ? <Ionicons name="hourglass" size={18} color="#2DD4BF" /> : <Ionicons name="camera" size={20} color="#2DD4BF" />}
                    </TouchableOpacity>
                    <TextInput style={[s.input, { flex: 1, marginBottom: 0 }]} placeholder="Type a message..." placeholderTextColor="#5A6B85" value={chatInput} onChangeText={setChatInput} />
                    <TouchableOpacity style={[s.btn, { marginTop: 0, paddingHorizontal: 16 }]} onPress={() => activeBookingId && sendMessage(activeBookingId)}>
                      <Text style={s.btnTxt}>Send</Text>
                    </TouchableOpacity>
                  </View>
                </>
              )}
            </>
          );
        })()}

        {driverArrivedAt && !tripStarted && (
          <View style={[s.card, { borderColor: waitingCharge > 0 ? "#f5a623" : "#2DD4BF", borderWidth: 1 }]}>
            {waitingCharge > 0 ? (
              <>
                <Text style={{ color: "#f5a623", fontWeight: "bold", textAlign: "center" }}><Ionicons name="time" size={14} color="#f5a623" /> Waiting Charge Active</Text>
                <Text style={{ color: "#F4F6FB", fontSize: 24, fontWeight: "bold", textAlign: "center", marginTop: 4 }}>GHS {waitingCharge}</Text>
                <Text style={{ color: "#8A9BB8", fontSize: 12, textAlign: "center" }}>GHS 1/min — auto-cancel at 15 mins total</Text>
              </>
            ) : (
              <>
                <Text style={{ color: "#2DD4BF", fontWeight: "bold", textAlign: "center" }}><Ionicons name="checkmark-circle" size={16} color="#2DD4BF" /> Arrived — waiting for client</Text>
                <Text style={{ color: "#F4F6FB", fontSize: 28, fontWeight: "bold", textAlign: "center", marginTop: 6 }}>
                  {String(Math.floor((300 - waitingSecondsElapsed) / 60)).padStart(2, "0")}:{String(Math.max(0, 300 - waitingSecondsElapsed) % 60).padStart(2, "0")}
                </Text>
                <Text style={{ color: "#8A9BB8", fontSize: 12, textAlign: "center", marginTop: 2 }}>free time remaining before waiting charges begin</Text>
              </>
            )}
          </View>
        )}

        {!driverArrivedAt ? (
          <TouchableOpacity style={[s.btnGreen, { marginBottom: 8 }]} onPress={() => activeBookingId && startWaitingTimer(activeBookingId)}>
            <Text style={{ color: "#2DD4BF", fontWeight: "bold" }}>{"📍"} I Have Arrived at Pickup</Text>
          </TouchableOpacity>
        ) : !tripStarted ? (
          <TouchableOpacity style={[s.btn, { marginBottom: 8 }]} onPress={startTrip}>
            <Text style={s.btnTxt}><Ionicons name="play" size={16} color="#04231F" /> Client Is Here — Start Trip</Text>
          </TouchableOpacity>
        ) : null}

        {tripStarted && activeOrder?.service === "motorbike" && (
          <>
            {!rideArrivedAtDelivery ? (
              <TouchableOpacity style={[s.btnGreen, { marginBottom: 12 }]} onPress={() => setRideArrivedAtDelivery(true)}>
                <Text style={{ color: "#2DD4BF", fontWeight: "bold" }}>{"📍"} I Have Arrived at Delivery Point</Text>
              </TouchableOpacity>
            ) : (
              <>
                <Text style={s.sectionTitle}>DELIVERY PROOF (REQUIRED)</Text>
                <Text style={{ color: "#8A9BB8", fontSize: 12, marginBottom: 10 }}>Take a photo showing the parcel was delivered — protects you if there's ever a dispute.</Text>
                <TouchableOpacity style={s.uploadBox} onPress={() => takeProofPhoto(setRideDeliveryProofPhoto)}>
                  {rideDeliveryProofPhoto ? <Image source={{ uri: rideDeliveryProofPhoto }} style={s.uploadImg} /> :
                    <><Ionicons name="camera" size={36} color="#2DD4BF" /><Text style={{ color: "#8A9BB8", marginTop: 8 }}>Tap to take delivery photo</Text></>}
                </TouchableOpacity>
              </>
            )}
          </>
        )}

        {tripStarted && (activeOrder?.service !== "motorbike" || rideArrivedAtDelivery) && (
          <Tappable style={s.btn} onPress={completeRide}>
            <Text style={s.btnTxt}><Ionicons name="checkmark-circle" size={16} color="#2DD4BF" /> Mark Ride Complete</Text>
          </Tappable>
        )}

        {sosCountdown > 0 ? (
          <View style={[s.sosBtn, { backgroundColor: "#F87171", borderColor: "#F87171" }]}>
            <Text style={{ color: "#F4F6FB", fontWeight: "bold" }}>Sending SOS in {sosCountdown}...</Text>
            <TouchableOpacity onPress={cancelSosCountdown} style={{ marginTop: 6 }}>
              <Text style={{ color: "#F4F6FB", textDecorationLine: "underline" }}>Cancel</Text>
            </TouchableOpacity>
          </View>
        ) : (
          <TouchableOpacity
            style={[s.sosBtn, sosHolding && { backgroundColor: "#F87171", borderColor: "#F87171" }]}
            onPressIn={startSosHold}
            onPressOut={cancelSosHold}>
            <Text style={{ color: sosHolding ? "#F4F6FB" : "#F87171", fontWeight: "bold", fontSize: 13 }}>
              {sosHolding ? "Keep holding..." : "Hold for SOS"}
            </Text>
          </TouchableOpacity>
        )}
      </ScrollView>
    </SafeAreaView>
  );
  }

  // DRIVER EARNINGS
  if (screen === "driverEarnings") return (
    <SafeAreaView style={s.safe}>
      <View style={s.nav}>
        <TouchableOpacity onPress={() => go(user?.role === "restaurant" ? "restaurantHome" : "driverHome")}><Text style={s.navLink}>Back</Text></TouchableOpacity>
        <Text style={s.navLogo}>My Earnings</Text>
        <View />
      </View>
      <ScrollView
        contentContainerStyle={{ padding: 20 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => handleRefresh(fetchWallet, fetchDriverRating)} tintColor="#2DD4BF" colors={["#2DD4BF"]} />}>
        {driverWallet?.balance < 0 && (
          <View style={{ backgroundColor: "#F8717122", borderWidth: 1, borderColor: "#F87171", borderRadius: 12, padding: 14, marginBottom: 16 }}>
            <Text style={{ color: "#F87171", fontWeight: "bold", fontSize: 14, marginBottom: 4 }}>You owe GHS {Math.abs(driverWallet.balance).toFixed(2)} to Luma</Text>
            <Text style={{ color: "#F4F6FB", fontSize: 12, lineHeight: 17 }}>
              This comes from cash rides/deliveries — you collected the full amount in person, but only part of it was actually yours to keep. It'll clear automatically as you complete more MoMo/Card trips.
            </Text>
          </View>
        )}
        <View style={s.row}>
          <View style={s.statCard}><Text style={s.statVal}>GHS {driverWallet?.balance?.toFixed(2) || "0.00"}</Text><Text style={s.statLabel}>Available Balance</Text></View>
          <View style={s.statCard}><Text style={s.statVal}>GHS {driverWallet?.total_earned?.toFixed(2) || "0.00"}</Text><Text style={s.statLabel}>Total Earned</Text></View>
        </View>
        <View style={s.row}>
          <View style={s.statCard}><Text style={s.statVal}>GHS {driverWallet?.total_withdrawn?.toFixed(2) || "0.00"}</Text><Text style={s.statLabel}>Total Withdrawn</Text></View>
          <View style={s.statCard}><Text style={s.statVal}>85%</Text><Text style={s.statLabel}>Your Cut</Text></View>
        </View>
        <Text style={s.sectionTitle}>WITHDRAW EARNINGS</Text>
        <TouchableOpacity style={s.btnGreen} onPress={withdrawEarnings}>
          <Text style={{ color: "#2DD4BF", fontWeight: "bold" }}><Ionicons name="phone-portrait" size={18} color="#5B8FE0" /> Withdraw via MoMo</Text>
        </TouchableOpacity>
        <Text style={{ color: "#5A6B85", fontSize: 12, textAlign: "center", marginTop: 8 }}>Minimum withdrawal: GHS 10 | Max GHS 2,000/day | Always free</Text>
      </ScrollView>
    </SafeAreaView>
  );

  // DRIVER PROFILE
  if (screen === "driverProfile") return (
    <SafeAreaView style={s.safe}>
      <View style={s.nav}>
        <TouchableOpacity onPress={() => go(user?.role === "restaurant" ? "restaurantHome" : "driverHome")}><Text style={s.navLink}>Back</Text></TouchableOpacity>
        <Text style={s.navLogo}>Profile & Settings</Text>
        <View />
      </View>
      <ScrollView contentContainerStyle={{ padding: 20 }}>
        <View style={s.card}>
          <TouchableOpacity onPress={uploadProfilePhoto} style={{ alignSelf: "center", marginBottom: 12 }}>
            <View style={{ width: 88, height: 88, borderRadius: 44, backgroundColor: "#2DD4BF18", alignItems: "center", justifyContent: "center", overflow: "hidden", borderWidth: 2, borderColor: "#2DD4BF" }}>
              {user?.profilePhoto
                ? <Image source={{ uri: user.profilePhoto }} style={{ width: 88, height: 88 }} />
                : <Ionicons name="person" size={40} color="#2DD4BF" />}
            </View>
            <View style={{ position: "absolute", bottom: 0, right: 0, width: 30, height: 30, borderRadius: 15, backgroundColor: "#2DD4BF", alignItems: "center", justifyContent: "center", borderWidth: 2, borderColor: "#131C2E" }}>
              <Ionicons name={uploadingPhoto ? "hourglass" : "camera"} size={15} color="#04231F" />
            </View>
          </TouchableOpacity>
          <Text style={[s.cardTitle, { textAlign: "center" }]}>{user?.name}</Text>
          <Text style={[s.cardSub, { textAlign: "center" }]}>{user?.email}</Text>
          <Text style={[s.cardSub, { textAlign: "center" }]}>{user?.phone}</Text>
          <View style={[s.badge, { backgroundColor: "#1a3a1a", marginTop: 8, alignSelf: "center" }]}>
            <Text style={{ color: "#2DD4BF", fontSize: 12 }}><Ionicons name="checkmark-circle" size={16} color="#2DD4BF" /> Verified Driver</Text>
          </View>
          <View style={[s.badge, { backgroundColor: "#1a2a1a", marginTop: 6, alignSelf: "center" }]}>
            <Text style={{ color: "#2DD4BF", fontSize: 12 }}><Ionicons name="star" size={16} color="#2DD4BF" /> {driverRating} average rating</Text>
          </View>
          <TouchableOpacity
            style={[s.btnOut, { marginTop: 12 }]}
            onPress={() => { setEditName(user?.name || ""); setEditPhone(user?.phone || ""); go("editProfile"); }}>
            <Text style={s.btnOutTxt}><Ionicons name="pencil" size={14} color="#2DD4BF" /> Edit Profile</Text>
          </TouchableOpacity>
        </View>

        <Text style={s.sectionTitle}>EARNINGS</Text>
        <TouchableOpacity style={s.card} onPress={() => go("driverEarnings")}>
          <Text style={s.cardTitle}><Ionicons name="wallet" size={20} color="#2DD4BF" /> My Earnings</Text>
          <Text style={s.cardSub}>View balance and withdraw anytime</Text>
        </TouchableOpacity>
        <View style={s.card}>
          <Text style={{ color: "#F4F6FB" }}>Platform takes: <Text style={{ color: "#2DD4BF", fontWeight: "bold" }}>15%</Text></Text>
          <Text style={{ color: "#F4F6FB" }}>You keep: <Text style={{ color: "#2DD4BF", fontWeight: "bold" }}>85% + 100% of tips</Text></Text>
        </View>

        <Text style={s.sectionTitle}>REFER A DRIVER</Text>
        <View style={[s.card, { borderColor: "#2DD4BF", borderWidth: 1 }]}>
          <Text style={s.cardTitle}><Ionicons name="gift" size={18} color="#2DD4BF" /> Your Referral Code</Text>
          <Text style={{ color: "#2DD4BF", fontSize: 20, fontWeight: "bold", marginTop: 6 }}>{user?.referralCode || "Loading..."}</Text>
          <Text style={s.cardSub}>Share this with other drivers. Earn GHS 15 once they complete their 10th ride.</Text>
        </View>

        <Text style={s.sectionTitle}>NOTIFICATIONS</Text>
        <View style={s.card}>
          <View style={s.onlineRow}>
            <Text style={{ color: "#F4F6FB", fontSize: 13 }}>Push Notifications</Text>
            <Switch value={pushNotifsEnabled} onValueChange={(v) => saveNotifPref("notif_push", v, setPushNotifsEnabled)} trackColor={{ false: "#333", true: "#2DD4BF" }} thumbColor="#F4F6FB" />
          </View>
          <View style={[s.onlineRow, { marginTop: 8 }]}>
            <Text style={{ color: "#F4F6FB", fontSize: 13 }}>New Ride Alerts</Text>
            <Switch value={rideUpdatesEnabled} onValueChange={(v) => saveNotifPref("notif_rides", v, setRideUpdatesEnabled)} trackColor={{ false: "#333", true: "#2DD4BF" }} thumbColor="#F4F6FB" />
          </View>
          <View style={[s.onlineRow, { marginTop: 8 }]}>
            <Text style={{ color: "#F4F6FB", fontSize: 13 }}>Promos & Incentives</Text>
            <Switch value={promoNotifsEnabled} onValueChange={(v) => saveNotifPref("notif_promos", v, setPromoNotifsEnabled)} trackColor={{ false: "#333", true: "#2DD4BF" }} thumbColor="#F4F6FB" />
          </View>
        </View>

        <Text style={s.sectionTitle}>SUPPORT</Text>
        <TouchableOpacity style={s.card} onPress={() => go("helpSupport")}>
          <Text style={s.cardTitle}><Ionicons name="chatbubble" size={18} color="#2DD4BF" /> Help & Support</Text>
          <Text style={s.cardSub}>FAQs, contact options, and how things work</Text>
        </TouchableOpacity>
        <TouchableOpacity style={s.card} onPress={() => go("aboutLuma")}>
          <Text style={s.cardTitle}><Ionicons name="information-circle" size={18} color="#2DD4BF" /> About Luma</Text>
          <Text style={s.cardSub}>Our mission, what we offer, and version info</Text>
        </TouchableOpacity>

        <TouchableOpacity style={[s.btnOut, { marginTop: 8 }]} onPress={logout}><Text style={s.btnOutTxt}>Log Out</Text></TouchableOpacity>
      </ScrollView>
    </SafeAreaView>
  );

  // CLIENT HOME
  if (screen === "clientHome") return (
    <SafeAreaView style={s.safe}>
      <View style={s.nav}>
        <TouchableOpacity onPress={() => go("clientSettings")} style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
          <Ionicons name="settings-outline" size={22} color="#2DD4BF" />
        </TouchableOpacity>
        <Wordmark fontSize={18} />
        <View style={{ flexDirection: "row", alignItems: "center", gap: 16 }}>
          <TouchableOpacity onPress={() => go("notifications")} style={{ position: "relative" }}>
            <Ionicons name="notifications-outline" size={22} color="#2DD4BF" />
            {unreadCount > 0 && (
              <View style={{ position: "absolute", top: -4, right: -6, backgroundColor: "#F87171", borderRadius: 8, minWidth: 16, height: 16, alignItems: "center", justifyContent: "center", paddingHorizontal: 3 }}>
                <Text style={{ color: "#fff", fontSize: 10, fontWeight: "700" }}>{unreadCount > 9 ? "9+" : unreadCount}</Text>
              </View>
            )}
          </TouchableOpacity>
          <TouchableOpacity onPress={() => go("clientProfile")}>
            <View style={{ width: 32, height: 32, borderRadius: 16, backgroundColor: "#2DD4BF22", borderWidth: 1.5, borderColor: "#2DD4BF", alignItems: "center", justifyContent: "center", overflow: "hidden" }}>
              {user?.profilePhoto
                ? <Image source={{ uri: user.profilePhoto }} style={{ width: 32, height: 32 }} />
                : <Text style={{ color: "#2DD4BF", fontSize: 14, fontWeight: "800" }}>{(user?.name || "U").charAt(0).toUpperCase()}</Text>}
            </View>
          </TouchableOpacity>
        </View>
      </View>
      <ScrollView contentContainerStyle={{ padding: 20 }}>
        <Text style={{ color: "#F4F6FB", fontSize: 18, fontWeight: "bold", marginBottom: 4 }}>Hello, {user?.name || "there"}!</Text>
        <Text style={{ color: "#8A9BB8", fontSize: 13, marginBottom: 12 }}>Where are you going today?</Text>

        {birthdayMode && (
          <View style={{ backgroundColor: "#2a1f0a", borderWidth: 1, borderColor: "#2DD4BF", borderRadius: 12, padding: 14, marginBottom: 16 }}>
            <Text style={{ color: "#2DD4BF", fontWeight: "bold", fontSize: 15 }}>🎂 It's the founder's birthday!</Text>
            <Text style={{ color: "#8A9BB8", fontSize: 12, marginTop: 4 }}>Thanks for riding with Luma — here's to another year.</Text>
          </View>
        )}

        <Tappable onPress={() => go("bookRide")} style={{ marginBottom: 20 }}>
          <View style={{ borderRadius: 16, overflow: "hidden" }}>
            <WebView
              style={{ width: "100%", height: 320 }}
              pointerEvents="none"
              source={{
                html: `<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"/><script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script><style>html,body,#map{height:100%;margin:0}@keyframes pulse{0%{transform:scale(0.6);opacity:0.7}70%{transform:scale(2.4);opacity:0}100%{opacity:0}}.pulse-ring{width:14px;height:14px;border-radius:50%;background:#2DD4BF;animation:pulse 2s ease-out infinite}</style></head><body><div id="map"></div><script>
                  var myLat=${location?.latitude || 6.6}, myLng=${location?.longitude || -0.9};
                  var map=L.map("map",{zoomControl:false,attributionControl:false,dragging:false,scrollWheelZoom:false,doubleClickZoom:false}).setView([myLat,myLng],15);
                  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",{maxZoom:19}).addTo(map);
                  var meIcon=L.divIcon({html:'<div style="position:relative;width:34px;height:42px;"><div class="pulse-ring" style="position:absolute;left:10px;top:14px;"></div><svg width="34" height="42" viewBox="0 0 34 42" xmlns="http://www.w3.org/2000/svg" style="position:relative;"><path d="M17 0C7.6 0 0 7.6 0 17c0 12 17 25 17 25s17-13 17-25C34 7.6 26.4 0 17 0z" fill="#2DD4BF"/><circle cx="17" cy="17" r="6" fill="#0B1220"/></svg></div>',iconSize:[34,42],iconAnchor:[17,42],className:"me-marker"});
                  L.marker([myLat,myLng],{icon:meIcon}).addTo(map);
                </script></body></html>`
              }}
            />
            <TouchableOpacity
              onPress={() => setFullMapView({ lat: null, lng: null, label: "Your Location", mode: "client" })}
              style={{ position: "absolute", top: 10, right: 10, backgroundColor: "#0B1220E6", borderRadius: 20, width: 40, height: 40, alignItems: "center", justifyContent: "center" }}>
              <Ionicons name="expand" size={18} color="#2DD4BF" />
            </TouchableOpacity>
            <View style={{ position: "absolute", bottom: 0, left: 0, right: 0, backgroundColor: "#0B1220E6", paddingVertical: 10, paddingHorizontal: 14, flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
              <Text style={{ color: "#F4F6FB", fontSize: 13, fontWeight: "600" }}>Tap to book a ride</Text>
              <Ionicons name="arrow-forward-circle" size={22} color="#2DD4BF" />
            </View>
          </View>
        </Tappable>

        <Text style={s.sectionTitle}>SERVICES</Text>

        {/* Hero card — Car Ride is the primary action, given full width and more visual weight */}
        <FadeInUp index={0}>
          <Tappable onPress={() => { setSelectedService("car"); setScheduleRide(false); go("bookRide"); }} style={[s.card, { flexDirection: "row", alignItems: "center", borderColor: "#2DD4BF", borderWidth: 1, marginBottom: 12 }]}>
            <View style={{ width: 58, height: 58, borderRadius: 29, backgroundColor: "#2DD4BF22", alignItems: "center", justifyContent: "center", marginRight: 16, overflow: "hidden" }}>
              <Image source={ICON_CAR} style={{ width: 44, height: 44 }} resizeMode="contain" />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={[s.cardTitle, { fontSize: 17 }]}>Car Ride</Text>
              <Text style={s.cardSub}>Point-to-point rides — your fastest option</Text>
            </View>
            <Ionicons name="chevron-forward" size={22} color="#2DD4BF" />
          </Tappable>
        </FadeInUp>

        {/* Secondary services — 2-column grid */}
        <View style={{ flexDirection: "row", flexWrap: "wrap", justifyContent: "space-between" }}>
          {[
            [ICON_TUKTUK, "Tuk Tuk", "Short trips", "tuktuk", "#F5A623", false],
            [ICON_MOTORBIKE, "Send Parcel", "Fast motorbike delivery", "motorbike", "#ff5722", false],
            [ICON_HOURLY, "Hourly Hire", "By the hour", "hire", "#5B8FE0", false],
            [ICON_FOOD, "Food Delivery", "Restaurants", "food", "#2DD4BF", false],
          ].map(([iconSrc, title, sub, type, color, soon], i) => (
            <FadeInUp key={title as string} index={i + 1} style={{ width: "48%", marginBottom: 12 }}>
              <Tappable
                disabled={!!soon}
                onPress={() => {
                  if (type === "hire") { go("hourlyHire"); return; }
                  if (type === "food") { go("foodDelivery"); return; }
                  setSelectedService(type as string);
                  setScheduleRide(false);
                  go("bookRide");
                }}
                style={[s.card, { alignItems: "flex-start", opacity: soon ? 0.6 : 1 }]}>
                <View style={{ flexDirection: "row", justifyContent: "space-between", width: "100%", alignItems: "flex-start" }}>
                  <View style={{ width: 46, height: 46, borderRadius: 23, backgroundColor: (color as string) + "22", alignItems: "center", justifyContent: "center", overflow: "hidden" }}>
                    <Image source={iconSrc as any} style={{ width: 36, height: 36 }} resizeMode="contain" />
                  </View>
                  {soon ? (
                    <View style={{ backgroundColor: "#8A9BB822", borderRadius: 8, paddingHorizontal: 8, paddingVertical: 3 }}>
                      <Text style={{ color: "#8A9BB8", fontSize: 10, fontWeight: "700", letterSpacing: 0.5 }}>SOON</Text>
                    </View>
                  ) : null}
                </View>
                <Text style={[s.cardTitle, { fontSize: 14, marginTop: 12 }]}>{title}</Text>
                <Text style={[s.cardSub, { fontSize: 12 }]}>{sub}</Text>
              </Tappable>
            </FadeInUp>
          ))}
        </View>


        <Text style={s.sectionTitle}>MY ACCOUNT</Text>
        {promoCredit > 0 && (
          <View style={[s.card, { borderColor: "#2DD4BF", borderWidth: 1, flexDirection: "row", alignItems: "center", justifyContent: "space-between" }]}>
            <View style={{ flexDirection: "row", alignItems: "center", flex: 1 }}>
              <View style={{ width: 52, height: 52, borderRadius: 26, backgroundColor: "#2DD4BF22", alignItems: "center", justifyContent: "center", marginRight: 16 }}>
                <Ionicons name="gift" size={26} color="#2DD4BF" />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={s.cardTitle}>Promo Credit</Text>
                <Text style={s.cardSub}>Applied automatically on your next ride</Text>
              </View>
            </View>
            <Text style={{ color: "#2DD4BF", fontSize: 20, fontWeight: "bold" }}>GHS {promoCredit}</Text>
          </View>
        )}
        <TouchableOpacity style={[s.card, { flexDirection: "row", alignItems: "center" }]} onPress={() => go("myBookings")}>
          <View style={{ width: 52, height: 52, borderRadius: 26, backgroundColor: "#2DD4BF22", alignItems: "center", justifyContent: "center", marginRight: 16 }}>
            <Ionicons name="clipboard" size={26} color="#2DD4BF" />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={s.cardTitle}>My Bookings</Text>
            <Text style={s.cardSub}>View all your rides and orders</Text>
          </View>
          <Ionicons name="chevron-forward" size={20} color="#2DD4BF" />
        </TouchableOpacity>
        <TouchableOpacity
          style={[s.card, { flexDirection: "row", alignItems: "center" }]}
          onPress={() => {
            setSelectedService("car");
            setScheduleRide(true);
            setScheduledDay(null);
            setScheduledTime(null);
            setPickupText(""); setDropoffText(""); setPickupPin(null); setDropoffPin(null);
            setEstFare(null); setEstKm(null);
            go("bookRide");
          }}>
          <View style={{ width: 52, height: 52, borderRadius: 26, backgroundColor: "#5B8FE022", alignItems: "center", justifyContent: "center", marginRight: 16 }}>
            <Ionicons name="calendar" size={26} color="#5B8FE0" />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={s.cardTitle}>Schedule a Ride</Text>
            <Text style={s.cardSub}>Book up to 7 days ahead for a specific time</Text>
          </View>
          <Ionicons name="chevron-forward" size={20} color="#5B8FE0" />
        </TouchableOpacity>
      </ScrollView>
    </SafeAreaView>
  );
  if (screen === "emergencyContacts") return (
    <SafeAreaView style={s.safe}>
      <View style={s.nav}>
        <TouchableOpacity onPress={() => go("clientSettings")}><Text style={s.navLink}>Back</Text></TouchableOpacity>
        <Text style={s.navLogo}>Safety</Text>
        <View />
      </View>
      <ScrollView contentContainerStyle={{ padding: 20 }}>
        <View style={{ flexDirection: "row", alignItems: "center", marginBottom: 8 }}>
          <Ionicons name="shield-checkmark" size={22} color="#F87171" />
          <Text style={{ color: "#F4F6FB", fontSize: 20, fontWeight: "700", marginLeft: 8 }}>Emergency Contacts</Text>
        </View>
        <Text style={{ color: "#8A9BB8", fontSize: 13, marginBottom: 20, lineHeight: 19 }}>
          Add up to 3 people who should be contacted if you ever use the SOS button during a ride. Your live location and ride details are shared with Luma admin the moment SOS is triggered.
        </Text>

        <Text style={s.sectionTitle}>YOUR CONTACTS</Text>
        {emergencyContacts.length === 0
          ? <EmptyState icon="person-add-outline" title="No contacts yet" subtitle="Add someone below who should be notified if you ever use the SOS button." />
          : emergencyContacts.map((c) => (
            <View key={c.id} style={[s.card, { flexDirection: "row", alignItems: "center" }]}>
              <View style={{ width: 44, height: 44, borderRadius: 22, backgroundColor: "#F8717122", alignItems: "center", justifyContent: "center", marginRight: 14 }}>
                <Ionicons name="person" size={20} color="#F87171" />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={{ color: "#F4F6FB", fontSize: 15, fontWeight: "600" }}>{c.name}</Text>
                <Text style={{ color: "#8A9BB8", fontSize: 13 }}>{c.phone}</Text>
              </View>
              <TouchableOpacity onPress={() => removeEmergencyContact(c.id)}>
                <Ionicons name="trash-outline" size={20} color="#8A9BB8" />
              </TouchableOpacity>
            </View>
          ))}

        {emergencyContacts.length < 3 && (
          <>
            <Text style={s.sectionTitle}>ADD A CONTACT</Text>
            <TextInput style={s.input} placeholder="Contact name" placeholderTextColor="#5A6B85" value={newContactName} onChangeText={setNewContactName} />
            <TextInput style={s.input} placeholder="Phone number" placeholderTextColor="#5A6B85" value={newContactPhone} onChangeText={setNewContactPhone} keyboardType="phone-pad" />
            <TouchableOpacity style={s.btn} onPress={addEmergencyContact}>
              <Text style={s.btnTxt}>Add Contact</Text>
            </TouchableOpacity>
          </>
        )}

        <View style={{ backgroundColor: "#2a1a1a", borderWidth: 1, borderColor: "#F8717140", borderRadius: 12, padding: 14, marginTop: 20 }}>
          <Text style={{ color: "#8A9BB8", fontSize: 12, lineHeight: 18 }}>
            <Ionicons name="information-circle" size={14} color="#F87171" /> In an emergency, always call the police directly on 191. SOS shares your location with admin and records your contacts for follow-up.
          </Text>
        </View>
      </ScrollView>
    </SafeAreaView>
  );

  if (screen === "notifications") return (
    <SafeAreaView style={s.safe}>
      <View style={s.nav}>
        <TouchableOpacity onPress={() => {
          const isDriver = ["car_driver", "tuktuk_driver", "motorbike_rider", "restaurant", "driver", "home_service"].includes(user?.role);
          go(isDriver ? "driverHome" : "clientHome");
        }}><Text style={s.navLink}>Back</Text></TouchableOpacity>
        <Text style={s.navLogo}>Notifications</Text>
        <View />
      </View>
      <ScrollView
        contentContainerStyle={{ padding: 20 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => handleRefresh(fetchNotifications)} tintColor="#2DD4BF" colors={["#2DD4BF"]} />}>
        {notifications.length > 0 && unreadCount > 0 && (
          <TouchableOpacity onPress={markAllNotificationsRead} style={{ alignSelf: "flex-end", marginBottom: 12 }}>
            <Text style={{ color: "#2DD4BF", fontSize: 13, fontWeight: "600" }}>Mark all as read</Text>
          </TouchableOpacity>
        )}
        {notifications.length === 0 ? (
          <EmptyState icon="notifications-outline" title="No notifications yet" subtitle="Updates about your rides, messages, and account will show up here." />
        ) : (
          notifications.map((n) => (
            <TouchableOpacity
              key={n.id}
              onPress={() => !n.read && markNotificationRead(n.id)}
              style={[
                s.card,
                { flexDirection: "row", alignItems: "flex-start" },
                !n.read && { borderColor: "#2DD4BF", borderWidth: 1 },
              ]}>
              {!n.read && <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: "#2DD4BF", marginRight: 10, marginTop: 6 }} />}
              <View style={{ flex: 1 }}>
                <Text style={{ color: "#F4F6FB", fontSize: 14, fontWeight: n.read ? "500" : "700" }}>{n.title}</Text>
                <Text style={{ color: "#8A9BB8", fontSize: 13, marginTop: 3, lineHeight: 18 }}>{n.body}</Text>
                <Text style={{ color: "#5A6B85", fontSize: 11, marginTop: 6 }}>{timeAgo(n.created_at)}</Text>
              </View>
            </TouchableOpacity>
          ))
        )}
      </ScrollView>
    </SafeAreaView>
  );

  // FOOD DELIVERY — RESTAURANT LIST
  if (screen === "foodDelivery") return (
    <SafeAreaView style={s.safe}>
      <View style={s.nav}>
        <TouchableOpacity onPress={() => go("clientHome")}><Text style={s.navLink}>Back</Text></TouchableOpacity>
        <Text style={s.navLogo}>Food Delivery</Text>
        <TouchableOpacity onPress={() => go("myFoodOrders")}><Ionicons name="receipt-outline" size={22} color="#2DD4BF" /></TouchableOpacity>
      </View>
      <ScrollView contentContainerStyle={{ padding: 20 }}>
        {restaurantList.length === 0 ? (
          <EmptyState icon="restaurant-outline" title="No restaurants open right now" subtitle="Check back soon — restaurants and vendors will appear here once they're open for orders." />
        ) : (
          restaurantList.map((r, i) => (
            <FadeInUp key={r.id} index={i}>
              <Tappable onPress={() => openRestaurantMenu(r)} style={[s.card, { flexDirection: "row", alignItems: "center" }]}>
                {r.restaurant_photo ? (
                  <Image source={{ uri: r.restaurant_photo }} style={{ width: 56, height: 56, borderRadius: 12, marginRight: 14 }} />
                ) : (
                  <View style={{ width: 56, height: 56, borderRadius: 12, backgroundColor: "#2DD4BF22", alignItems: "center", justifyContent: "center", marginRight: 14 }}>
                    <Ionicons name="restaurant" size={26} color="#2DD4BF" />
                  </View>
                )}
                <View style={{ flex: 1 }}>
                  <Text style={s.cardTitle}>{r.business_name}</Text>
                  <Text style={s.cardSub}>Open for orders</Text>
                </View>
                <Ionicons name="chevron-forward" size={20} color="#2DD4BF" />
              </Tappable>
            </FadeInUp>
          ))
        )}
      </ScrollView>
    </SafeAreaView>
  );

  // FOOD DELIVERY — RESTAURANT MENU + CART
  if (screen === "restaurantMenu") return (
    <SafeAreaView style={s.safe}>
      <View style={s.nav}>
        <TouchableOpacity onPress={() => go("foodDelivery")}><Text style={s.navLink}>Back</Text></TouchableOpacity>
        <Text style={s.navLogo} numberOfLines={1}>{viewingRestaurant?.business_name}</Text>
        <View />
      </View>
      <ScrollView contentContainerStyle={{ padding: 20, paddingBottom: 100 }}>
        {viewingMenu.length === 0 ? (
          <EmptyState icon="fast-food-outline" title="No dishes available" subtitle="This restaurant hasn't added any dishes yet." />
        ) : (
          viewingMenu.map((item) => {
            const inCart = foodCart.find(c => c.item.id === item.id);
            return (
              <View key={item.id} style={[s.card, { flexDirection: "row", alignItems: "center" }]}>
                <Image source={{ uri: item.photo_url }} style={{ width: 60, height: 60, borderRadius: 10, marginRight: 14 }} />
                <View style={{ flex: 1 }}>
                  <Text style={s.cardTitle}>{item.name}</Text>
                  {item.description ? <Text style={s.cardSub}>{item.description}</Text> : null}
                  <Text style={{ color: "#2DD4BF", fontWeight: "bold", marginTop: 4 }}>GHS {item.price}</Text>
                </View>
                {inCart ? (
                  <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
                    <TouchableOpacity onPress={() => removeFromCart(item.id)} style={{ width: 30, height: 30, borderRadius: 15, backgroundColor: "#1B2A44", alignItems: "center", justifyContent: "center" }}>
                      <Ionicons name="remove" size={18} color="#F4F6FB" />
                    </TouchableOpacity>
                    <Text style={{ color: "#F4F6FB", fontWeight: "700" }}>{inCart.quantity}</Text>
                    <TouchableOpacity onPress={() => addToCart(item)} style={{ width: 30, height: 30, borderRadius: 15, backgroundColor: "#2DD4BF", alignItems: "center", justifyContent: "center" }}>
                      <Ionicons name="add" size={18} color="#04231F" />
                    </TouchableOpacity>
                  </View>
                ) : (
                  <TouchableOpacity onPress={() => addToCart(item)} style={{ width: 34, height: 34, borderRadius: 17, backgroundColor: "#2DD4BF", alignItems: "center", justifyContent: "center" }}>
                    <Ionicons name="add" size={20} color="#04231F" />
                  </TouchableOpacity>
                )}
              </View>
            );
          })
        )}
      </ScrollView>
      {foodCart.length > 0 && (
        <TouchableOpacity style={{ position: "absolute", bottom: 20, left: 20, right: 20, backgroundColor: "#2DD4BF", borderRadius: 14, padding: 16, flexDirection: "row", justifyContent: "space-between", alignItems: "center" }} onPress={() => go("foodCart")}>
          <Text style={{ color: "#04231F", fontWeight: "800", fontSize: 15 }}>{foodCart.reduce((n, c) => n + c.quantity, 0)} item{foodCart.reduce((n, c) => n + c.quantity, 0) === 1 ? "" : "s"} — View Cart</Text>
          <Text style={{ color: "#04231F", fontWeight: "800", fontSize: 15 }}>GHS {cartTotal().toFixed(2)}</Text>
        </TouchableOpacity>
      )}
    </SafeAreaView>
  );

  // FOOD DELIVERY — CART / CHECKOUT
  if (screen === "foodCart") return (
    <SafeAreaView style={s.safe}>
      <View style={s.nav}>
        <TouchableOpacity onPress={() => go("restaurantMenu")}><Text style={s.navLink}>Back</Text></TouchableOpacity>
        <Text style={s.navLogo}>Your Cart</Text>
        <View />
      </View>
      <ScrollView contentContainerStyle={{ padding: 20 }}>
        <Text style={s.sectionTitle}>ITEMS</Text>
        {foodCart.map((c) => (
          <View key={c.item.id} style={{ flexDirection: "row", justifyContent: "space-between", marginBottom: 10 }}>
            <Text style={{ color: "#F4F6FB", fontSize: 14 }}>{c.quantity}x {c.item.name}</Text>
            <Text style={{ color: "#8A9BB8", fontSize: 14 }}>GHS {(c.item.price * c.quantity).toFixed(2)}</Text>
          </View>
        ))}
        <View style={s.divider} />
        <View style={{ flexDirection: "row", justifyContent: "space-between", marginBottom: 20 }}>
          <Text style={{ color: "#F4F6FB", fontWeight: "700", fontSize: 15 }}>Subtotal</Text>
          <Text style={{ color: "#2DD4BF", fontWeight: "700", fontSize: 15 }}>GHS {cartTotal().toFixed(2)}</Text>
        </View>
        <Text style={{ color: "#5A6B85", fontSize: 11, marginTop: -14, marginBottom: 20 }}>Delivery fee is calculated after you confirm your address below.</Text>

        <Text style={s.sectionTitle}>DELIVERY ADDRESS</Text>
        <TextInput
          style={s.input}
          placeholder="Enter your delivery address"
          placeholderTextColor="#5A6B85"
          value={foodDeliveryAddress}
          onChangeText={setFoodDeliveryAddress}
        />
        <TouchableOpacity
          style={[s.btnOut, { marginBottom: 8 }]}
          onPress={async () => {
            if (!location) { showAlert("Location unavailable", "Please enter your address manually."); return; }
            const address = await reverseGeocode(location.latitude, location.longitude);
            setFoodDeliveryAddress(address);
          }}>
          <Text style={s.btnOutTxt}><Ionicons name="locate" size={14} color="#2DD4BF" /> Use My Current Location</Text>
        </TouchableOpacity>

        <Text style={s.sectionTitle}>PAYMENT METHOD</Text>
        <Text style={{ color: "#5A6B85", fontSize: 11, marginTop: -4, marginBottom: 10 }}>Food orders are paid upfront — cash isn't available for delivery, since your order is confirmed and sent to the restaurant immediately after payment.</Text>
        <View style={s.serviceRow}>
          {["momo", "card"].map((m) => (
            <TouchableOpacity
              key={m}
              style={[s.serviceBtn, { borderColor: foodDeliveryPayment === m ? "#2DD4BF" : "#1B2A44", backgroundColor: foodDeliveryPayment === m ? "#2DD4BF22" : "#131C2E" }]}
              onPress={() => setFoodDeliveryPayment(m)}>
              <Text style={{ color: foodDeliveryPayment === m ? "#2DD4BF" : "#8A9BB8", fontWeight: "600", fontSize: 13 }}>{m === "momo" ? "MoMo" : "Card"}</Text>
            </TouchableOpacity>
          ))}
        </View>

        <TouchableOpacity
          style={[s.btn, { marginTop: 16 }]}
          onPress={() => {
            if (!foodDeliveryAddress.trim()) { showAlert("Missing address", "Please enter where this order should be delivered."); return; }
            const lat = location?.latitude || 6.6;
            const lng = location?.longitude || -0.9;
            submitFoodOrder(foodDeliveryAddress, lat, lng, foodDeliveryPayment);
          }}>
          <Text style={s.btnTxt}>Place Order — GHS {cartTotal().toFixed(2)}+ delivery</Text>
        </TouchableOpacity>
      </ScrollView>
    </SafeAreaView>
  );

  // FOOD DELIVERY — MY ORDERS LIST
  if (screen === "myFoodOrders") return (
    <SafeAreaView style={s.safe}>
      <View style={s.nav}>
        <TouchableOpacity onPress={() => go("foodDelivery")}><Text style={s.navLink}>Back</Text></TouchableOpacity>
        <Text style={s.navLogo}>My Food Orders</Text>
        <View />
      </View>
      <ScrollView contentContainerStyle={{ padding: 20 }}>
        {foodOrders.length === 0 ? (
          <EmptyState icon="fast-food-outline" title="No orders yet" subtitle="Your food orders will show up here." />
        ) : (
          foodOrders.map((order) => (
            <Tappable key={order.id} onPress={() => { setActiveFoodOrderId(order.id); go("foodOrderTracking"); }} style={s.card}>
              <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
                <Text style={s.cardTitle}>{order.restaurant_name}</Text>
                <Text style={{ color: "#2DD4BF", fontWeight: "bold" }}>GHS {order.total}</Text>
              </View>
              <Text style={s.cardSub}>{order.status.replace(/_/g, " ")}</Text>
              {order.status === "pending" && order.payment !== "cash" && order.payment_status !== "paid" && (
                <TouchableOpacity style={[s.btnGreen, { marginTop: 8 }]} onPress={() => {
                  setFoodPaymentOrderId(order.id);
                  setFoodPaymentAmount(order.subtotal);
                  setFoodPaymentMethod(order.payment);
                  setShowFoodPaystack(true);
                }}>
                  <Text style={{ color: "#2DD4BF", fontWeight: "bold" }}><Ionicons name="card" size={15} color="#2DD4BF" /> Retry Payment</Text>
                </TouchableOpacity>
              )}
              {order.status === "delivered" && order.delivery_fee_status === "awaiting_payment" && (
                <TouchableOpacity style={[s.btnGreen, { marginTop: 8 }]} onPress={() => {
                  setDeliveryFeeOrderId(order.id);
                  setDeliveryFeeAmount(order.delivery_fee);
                  setShowDeliveryFeePaystack(true);
                }}>
                  <Text style={{ color: "#2DD4BF", fontWeight: "bold" }}><Ionicons name="cash" size={15} color="#2DD4BF" /> Pay Delivery Fee</Text>
                </TouchableOpacity>
              )}
              {order.status === "delivered" && !order.food_rating && (
                <TouchableOpacity style={[s.btnGreen, { marginTop: 8 }]} onPress={() => openFoodRatingModal(order.id)}>
                  <Text style={{ color: "#2DD4BF", fontWeight: "bold" }}><Ionicons name="star" size={15} color="#2DD4BF" /> Rate Your Order</Text>
                </TouchableOpacity>
              )}
              {order.status === "delivered" && order.payment !== "cash" && order.payment_status === "paid" && (
                <TouchableOpacity style={[s.btnOut, { marginTop: 6 }]} onPress={() => { setRefundTargetFoodOrderId(order.id); go("requestRefund"); }}>
                  <Text style={s.btnOutTxt}><Ionicons name="cash" size={14} color="#2DD4BF" /> Request Refund</Text>
                </TouchableOpacity>
              )}
            </Tappable>
          ))
        )}
      </ScrollView>
    </SafeAreaView>
  );

  // FOOD DELIVERY — ORDER TRACKING
  if (screen === "foodOrderTracking") {
    const activeOrder = foodOrders.find(o => o.id === activeFoodOrderId);
    const statusSteps = ["pending", "preparing", "ready_for_pickup", "rider_assigned", "picked_up", "delivered"];
    const currentStepIndex = activeOrder ? statusSteps.indexOf(activeOrder.status) : 0;
    return (
      <SafeAreaView style={s.safe}>
        <View style={s.nav}>
          <TouchableOpacity onPress={() => go("myFoodOrders")}><Text style={s.navLink}>Back</Text></TouchableOpacity>
          <Text style={s.navLogo}>Order Status</Text>
          <View />
        </View>
        <ScrollView contentContainerStyle={{ padding: 20 }}>
          <View style={s.card}>
            <Text style={s.cardTitle}>{activeOrder?.restaurant_name || "Your Order"}</Text>
            <Text style={s.cardSub}>Delivering to: {activeOrder?.delivery_address}</Text>
            <Text style={{ color: "#2DD4BF", fontWeight: "bold", marginTop: 8 }}>GHS {activeOrder?.total}</Text>
          </View>
          <Text style={s.sectionTitle}>STATUS</Text>
          {[
            ["pending", "Order placed"],
            ["preparing", "Restaurant is preparing your food"],
            ["ready_for_pickup", "Ready — waiting for a rider"],
            ["rider_assigned", "Rider is on the way to pick up"],
            ["picked_up", "Rider has your order — on the way to you"],
            ["delivered", "Delivered — enjoy your meal!"],
          ].map(([key, label], i) => (
            <View key={key} style={{ flexDirection: "row", alignItems: "center", marginBottom: 14 }}>
              <View style={{ width: 24, height: 24, borderRadius: 12, backgroundColor: i <= currentStepIndex ? "#2DD4BF" : "#1B2A44", alignItems: "center", justifyContent: "center", marginRight: 12 }}>
                {i <= currentStepIndex && <Ionicons name="checkmark" size={14} color="#04231F" />}
              </View>
              <Text style={{ color: i <= currentStepIndex ? "#F4F6FB" : "#5A6B85", fontSize: 13 }}>{label}</Text>
            </View>
          ))}
          {(activeOrder?.status === "rider_assigned" || activeOrder?.status === "picked_up") && (
            <>
              <Text style={s.sectionTitle}>LIVE RIDER LOCATION</Text>
              {riderEtaMinutes != null && (
                <View style={{ flexDirection: "row", alignItems: "center", marginBottom: 10, backgroundColor: "#2DD4BF18", borderRadius: 10, paddingVertical: 8, paddingHorizontal: 12, alignSelf: "flex-start" }}>
                  <Ionicons name="time" size={16} color="#2DD4BF" />
                  <Text style={{ color: "#2DD4BF", fontWeight: "700", marginLeft: 6 }}>
                    {riderEtaMinutes <= 1 ? "Arriving now" : `${riderEtaMinutes} min away`}
                  </Text>
                </View>
              )}
              <View style={{ position: "relative" }}>
                <WebView
                  style={{ width: "100%", height: 320, borderRadius: 12, marginBottom: 12 }}
                  source={{
                    html: `<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"/><script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script><style>html,body,#map{height:100%;margin:0}</style></head><body><div id="map"></div><script>
                      var riderLat=${riderLiveLocation?.latitude || activeOrder?.delivery_lat || location?.latitude || 6.6};
                      var riderLng=${riderLiveLocation?.longitude || activeOrder?.delivery_lng || location?.longitude || -0.9};
                      var map=L.map("map",{attributionControl:false,zoomControl:true,dragging:true,touchZoom:true,scrollWheelZoom:true,doubleClickZoom:true}).setView([riderLat,riderLng],15);
                      L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",{maxZoom:19}).addTo(map);
                      var riderIcon=L.divIcon({html:'<svg width="38" height="46" viewBox="0 0 38 46" xmlns="http://www.w3.org/2000/svg"><path d="M19 0C8.5 0 0 8.5 0 19c0 13.3 19 27 19 27s19-13.7 19-27C38 8.5 29.5 0 19 0z" fill="#0B1220" stroke="#FF5722" stroke-width="2"/><circle cx="19" cy="19" r="7" fill="#FF5722"/></svg>',iconSize:[38,46],iconAnchor:[19,46],className:"rider-marker"});
                      L.marker([riderLat,riderLng],{icon:riderIcon}).addTo(map).bindPopup("Your Rider").openPopup();
                    </script></body></html>`
                  }}
                />
                <TouchableOpacity
                  onPress={() => openFullMap(activeOrder?.delivery_address, "Delivery Location", "client")}
                  style={{ position: "absolute", top: 10, right: 10, backgroundColor: "#0B1220E6", borderRadius: 20, width: 40, height: 40, alignItems: "center", justifyContent: "center" }}>
                  <Ionicons name="expand" size={18} color="#2DD4BF" />
                </TouchableOpacity>
              </View>
              {riderLiveLocation
                ? <Text style={{ color: "#2DD4BF", textAlign: "center", marginBottom: 12 }}>{"●"} Live — updating every 3 seconds</Text>
                : <Text style={{ color: "#8A9BB8", textAlign: "center", marginBottom: 12 }}>Waiting for rider location...</Text>
              }
            </>
          )}
          {activeOrder?.delivery_photo && (
            <>
              <Text style={s.sectionTitle}>DELIVERY PROOF</Text>
              <Image source={{ uri: activeOrder.delivery_photo }} style={{ width: "100%", height: 180, borderRadius: 12 }} />
            </>
          )}
        </ScrollView>
      </SafeAreaView>
    );
  }

  // MOTORBIKE RIDER — AVAILABLE FOOD DELIVERIES
  if (screen === "availableFoodDeliveries") return (
    <SafeAreaView style={s.safe}>
      <View style={s.nav}>
        <TouchableOpacity onPress={() => go("driverHome")}><Text style={s.navLink}>Back</Text></TouchableOpacity>
        <Text style={s.navLogo}>Food Deliveries</Text>
        <View />
      </View>
      <ScrollView contentContainerStyle={{ padding: 20 }}>
        {!online ? (
          <EmptyState icon="moon-outline" title="You're offline" subtitle="Go online from your home screen to see available food deliveries." />
        ) : availableFoodDeliveries.length === 0 ? (
          <EmptyState icon="fast-food-outline" title="No deliveries right now" subtitle="Ready-for-pickup food orders will appear here." />
        ) : (
          availableFoodDeliveries.map((order) => (
            <View key={order.id} style={s.card}>
              <Text style={s.cardTitle}>{order.restaurant_name}</Text>
              <Text style={s.cardSub}>Deliver to: {order.delivery_address}</Text>
              <Text style={{ color: "#2DD4BF", fontWeight: "bold", marginTop: 6 }}>GHS {order.delivery_fee} delivery fee</Text>
              <TouchableOpacity style={[s.btn, { marginTop: 10 }]} onPress={() => acceptFoodDelivery(order.id)}>
                <Text style={s.btnTxt}>Accept Delivery</Text>
              </TouchableOpacity>
            </View>
          ))
        )}
      </ScrollView>
    </SafeAreaView>
  );

  // MOTORBIKE RIDER — ACTIVE FOOD DELIVERY
  if (screen === "activeFoodDelivery") {
    const activeDelivery = availableFoodDeliveries.find(o => o.id === activeFoodOrderId) || incomingFoodOrders.find(o => o.id === activeFoodOrderId);
    const isPickedUp = activeDeliveryStage === "delivery";
    return (
      <SafeAreaView style={s.safe}>
        <View style={s.nav}>
          <TouchableOpacity onPress={() => go("driverHome")}><Text style={s.navLink}>Back</Text></TouchableOpacity>
          <Text style={s.navLogo}>Active Delivery</Text>
          <View />
        </View>
        <ScrollView contentContainerStyle={{ padding: 20 }}>
          <View style={s.card}>
            <Text style={s.cardTitle}><Ionicons name="restaurant" size={15} color="#F4F6FB" /> Pickup: {activeDelivery?.restaurant_name || "Restaurant"}</Text>
            <Text style={{ color: "#8A9BB8", fontSize: 13, marginTop: 8 }}><Ionicons name="flag" size={13} color="#8A9BB8" /> Deliver to: {activeDelivery?.delivery_address}</Text>
            <Text style={{ color: "#2DD4BF", fontWeight: "bold", marginTop: 8 }}>GHS {activeDelivery?.delivery_fee} delivery fee</Text>
          </View>

          {!isPickedUp ? (
            <>
              <Text style={s.sectionTitle}>PICKUP PROOF</Text>
              <Text style={{ color: "#8A9BB8", fontSize: 12, marginBottom: 10 }}>Take a photo of the order at the restaurant before heading out.</Text>
              <TouchableOpacity style={s.uploadBox} onPress={() => takeProofPhoto(setPickupProofPhoto)}>
                {pickupProofPhoto ? <Image source={{ uri: pickupProofPhoto }} style={s.uploadImg} /> :
                  <><Ionicons name="camera" size={36} color="#2DD4BF" /><Text style={{ color: "#8A9BB8", marginTop: 8 }}>Tap to take pickup photo</Text></>}
              </TouchableOpacity>
              {uploadingProof ? (
                <Pulse label="Uploading..." size={28} />
              ) : (
                <TouchableOpacity style={[s.btnGreen, { opacity: pickupProofPhoto ? 1 : 0.5 }]} onPress={() => activeFoodOrderId && markFoodPickedUp(activeFoodOrderId)}>
                  <Text style={{ color: "#2DD4BF", fontWeight: "bold" }}>Mark Picked Up From Restaurant</Text>
                </TouchableOpacity>
              )}
            </>
          ) : (
            <>
              <Text style={s.sectionTitle}>NAVIGATE TO CLIENT</Text>
              <View style={{ position: "relative" }}>
                <WebView
                  style={{ width: "100%", height: 300, borderRadius: 12, marginBottom: 16 }}
                  source={{
                    html: `<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"/><script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script><style>html,body,#map{height:100%;margin:0}</style></head><body><div id="map"></div><script>
                      var myLat=${riderLiveLocation?.latitude || location?.latitude || 6.6};
                      var myLng=${riderLiveLocation?.longitude || location?.longitude || -0.9};
                      var destLat=${activeDelivery?.delivery_lat || myLat};
                      var destLng=${activeDelivery?.delivery_lng || myLng};
                      var map=L.map("map",{attributionControl:false,zoomControl:true,dragging:true,touchZoom:true,scrollWheelZoom:true,doubleClickZoom:true}).fitBounds([[myLat,myLng],[destLat,destLng]],{padding:[30,30]});
                      L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",{maxZoom:19}).addTo(map);
                      fetch("https://router.project-osrm.org/route/v1/driving/" + myLng + "," + myLat + ";" + destLng + "," + destLat + "?overview=full&geometries=geojson")
                        .then(function(r){ return r.json(); })
                        .then(function(data){
                          if (data && data.routes && data.routes[0] && data.routes[0].geometry) {
                            var coords = data.routes[0].geometry.coordinates.map(function(c){ return [c[1], c[0]]; });
                            L.polyline(coords, {color:"#0B1220", weight:9, opacity:0.55, lineJoin:"round", lineCap:"round"}).addTo(map);
                            L.polyline(coords, {color:"#2DD4BF", weight:6, opacity:1, lineJoin:"round", lineCap:"round"}).addTo(map);
                          } else {
                            L.polyline([[myLat,myLng],[destLat,destLng]], {color:"#0B1220", weight:6, opacity:0.4, lineCap:"round"}).addTo(map);
                            L.polyline([[myLat,myLng],[destLat,destLng]], {color:"#2DD4BF", weight:4, opacity:0.85, dashArray:"6,8", lineCap:"round"}).addTo(map);
                          }
                        }).catch(function(){
                          L.polyline([[myLat,myLng],[destLat,destLng]], {color:"#0B1220", weight:6, opacity:0.4, lineCap:"round"}).addTo(map);
                          L.polyline([[myLat,myLng],[destLat,destLng]], {color:"#2DD4BF", weight:4, opacity:0.85, dashArray:"6,8", lineCap:"round"}).addTo(map);
                        });
                      var meIcon=L.divIcon({html:'<div style="width:20px;height:20px;background:#FF5722;border:3px solid #fff;border-radius:50%;box-shadow:0 0 6px rgba(0,0,0,0.4);"></div>',iconSize:[20,20],className:""});
                      var destIcon=L.divIcon({html:'<svg width="32" height="40" viewBox="0 0 32 40" xmlns="http://www.w3.org/2000/svg"><path d="M16 0C7.2 0 0 7.2 0 16c0 11.2 16 24 16 24s16-12.8 16-24C32 7.2 24.8 0 16 0z" fill="#2DD4BF"/><circle cx="16" cy="16" r="6" fill="#04231F"/></svg>',iconSize:[32,40],iconAnchor:[16,40],className:""});
                      L.marker([myLat,myLng],{icon:meIcon}).addTo(map).bindPopup("You");
                      L.marker([destLat,destLng],{icon:destIcon}).addTo(map).bindPopup("Client");
                    </script></body></html>`
                  }}
                />
                <TouchableOpacity
                  onPress={() => setFullMapView({
                    lat: activeDelivery?.delivery_lat || riderLiveLocation?.latitude || location?.latitude || 6.6,
                    lng: activeDelivery?.delivery_lng || riderLiveLocation?.longitude || location?.longitude || -0.9,
                    label: "Client Location",
                    mode: "driver",
                  })}
                  style={{ position: "absolute", top: 10, right: 10, backgroundColor: "#0B1220E6", borderRadius: 20, width: 40, height: 40, alignItems: "center", justifyContent: "center" }}>
                  <Ionicons name="expand" size={18} color="#2DD4BF" />
                </TouchableOpacity>
              </View>
              <Text style={s.sectionTitle}>DELIVERY PROOF</Text>
              <Text style={{ color: "#8A9BB8", fontSize: 12, marginBottom: 10 }}>Take a photo showing the order was delivered — protects you if there's ever a dispute.</Text>
              <TouchableOpacity style={s.uploadBox} onPress={() => takeProofPhoto(setDeliveryProofPhoto)}>
                {deliveryProofPhoto ? <Image source={{ uri: deliveryProofPhoto }} style={s.uploadImg} /> :
                  <><Ionicons name="camera" size={36} color="#2DD4BF" /><Text style={{ color: "#8A9BB8", marginTop: 8 }}>Tap to take delivery photo</Text></>}
              </TouchableOpacity>
              {uploadingProof ? (
                <Pulse label="Uploading..." size={28} />
              ) : (
                <TouchableOpacity style={[s.btn, { opacity: deliveryProofPhoto ? 1 : 0.5 }]} onPress={() => activeFoodOrderId && markFoodDelivered(activeFoodOrderId)}>
                  <Text style={s.btnTxt}>Mark Delivered to Client</Text>
                </TouchableOpacity>
              )}
            </>
          )}
        </ScrollView>
      </SafeAreaView>
    );
  }

  if (screen === "bookRide") return (
    <SafeAreaView style={s.safe}>
      <View style={s.nav}>
        <TouchableOpacity onPress={() => go("clientHome")}><Text style={s.navLink}>Back</Text></TouchableOpacity>
        <Text style={s.navLogo}>{scheduleRide ? "Schedule a Ride" : `Book a ${selectedService === "tuktuk" ? "Tuk Tuk" : selectedService === "motorbike" ? "Delivery" : "Ride"}`}</Text>
        <View />
      </View>
      <ScrollView contentContainerStyle={{ padding: 16 }} keyboardShouldPersistTaps="handled">

        <Text style={s.sectionTitle}>PICKUP LOCATION</Text>
        <TextInput style={s.input} placeholder="Search pickup address..." placeholderTextColor="#5A6B85" value={pickupText} onChangeText={pickupChange} onFocus={() => setActiveField("pickup")} />
        {activeField === "pickup" && searchingPlaces && pickupSugg.length === 0 && (
          <View style={s.suggestBox}><View style={s.suggestItem}><Text style={{ color: "#8A9BB8", fontSize: 13 }}>Searching Ghana...</Text></View></View>
        )}
        {activeField === "pickup" && pickupSugg.length > 0 && (
          <View style={s.suggestBox}>
            {pickupSugg.map((p, i) => (
              <TouchableOpacity key={i} style={s.suggestItem} onPress={() => selPickup(p)}>
                <Text style={s.suggestTxt}><Ionicons name="location" size={13} color="#2DD4BF" style={{marginRight:4}} /> {p.name.length > 60 ? p.name.substring(0, 60) + "..." : p.name}</Text>
              </TouchableOpacity>
            ))}
          </View>
        )}
        <TouchableOpacity
          style={[s.btnOut, { marginBottom: 12 }]}
          onPress={async () => {
            if (!location) { showAlert("Location unavailable", "Please enter the pickup address manually."); return; }
            setPickupText("Finding you on the map...");
            const address = await reverseGeocode(location.latitude, location.longitude);
            setPickupText(address);
            setPickupPin({ latitude: location.latitude, longitude: location.longitude });
            if (dropoffPin) updateFare(location.latitude, location.longitude, dropoffPin.latitude, dropoffPin.longitude);
          }}>
          <Text style={s.btnOutTxt}><Ionicons name="locate" size={14} color="#2DD4BF" /> Use My Current Location</Text>
        </TouchableOpacity>
        <Text style={{ color: "#5A6B85", fontSize: 11, marginTop: -8, marginBottom: 12 }}>
          Picking someone else up? Just search their location above instead — current location is only used if you tap the button.
        </Text>

        <Text style={s.sectionTitle}>DROPOFF LOCATION</Text>
        <TextInput style={s.input} placeholder="Search dropoff address..." placeholderTextColor="#5A6B85" value={dropoffText} onChangeText={dropoffChange} onFocus={() => setActiveField("dropoff")} />
        {activeField === "dropoff" && searchingPlaces && dropoffSugg.length === 0 && (
          <View style={s.suggestBox}><View style={s.suggestItem}><Text style={{ color: "#8A9BB8", fontSize: 13 }}>Searching Ghana...</Text></View></View>
        )}
        {activeField === "dropoff" && dropoffSugg.length > 0 && (
          <View style={s.suggestBox}>
            {dropoffSugg.map((p, i) => (
              <TouchableOpacity key={i} style={s.suggestItem} onPress={() => selDropoff(p)}>
                <Text style={s.suggestTxt}><Ionicons name="flag" size={13} color="#2DD4BF" style={{marginRight:4}} /> {p.name.length > 60 ? p.name.substring(0, 60) + "..." : p.name}</Text>
              </TouchableOpacity>
            ))}
          </View>
        )}
        {homeAddress && dropoffText !== homeAddress.text && (
          <Tappable
            onPress={() => selDropoff({ name: homeAddress.text, lat: homeAddress.lat, lon: homeAddress.lng })}
            style={{ flexDirection: "row", alignItems: "center", backgroundColor: "#2DD4BF18", borderWidth: 1, borderColor: "#2DD4BF", borderRadius: 24, paddingVertical: 8, paddingHorizontal: 14, alignSelf: "flex-start", marginBottom: 14 }}>
            <Ionicons name="home" size={15} color="#2DD4BF" />
            <Text style={{ color: "#2DD4BF", fontSize: 13, fontWeight: "600", marginLeft: 6 }}>Use Home — {homeAddress.text.split(",")[0]}</Text>
          </Tappable>
        )}

        {extraStops.map((stop, index) => (
          <View key={index}>
            <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
              <Text style={s.sectionTitle}>STOP {index + 2}</Text>
              <TouchableOpacity onPress={() => removeStop(index)}>
                <Text style={{ color: "#F87171", fontSize: 13 }}>Remove</Text>
              </TouchableOpacity>
            </View>
            <TextInput
              style={s.input}
              placeholder={`Search stop ${index + 2} address...`}
              placeholderTextColor="#5A6B85"
              value={stop.text}
              onChangeText={(t) => stopTextChange(index, t)}
            />
            {stop.suggestions.length > 0 && (
              <View style={s.suggestBox}>
                {stop.suggestions.map((p: any, i: number) => (
                  <TouchableOpacity key={i} style={s.suggestItem} onPress={() => selStop(index, p)}>
                    <Text style={s.suggestTxt}><Ionicons name="location" size={13} color="#2DD4BF" style={{marginRight:4}} /> {p.name.length > 60 ? p.name.substring(0, 60) + "..." : p.name}</Text>
                  </TouchableOpacity>
                ))}
              </View>
            )}
          </View>
        ))}

        {extraStops.length < 2 && (
          <TouchableOpacity
            style={{ flexDirection: "row", alignItems: "center", gap: 6, marginBottom: 12, paddingVertical: 6 }}
            onPress={addStop}>
            <Text style={{ color: "#2DD4BF", fontSize: 20 }}>{"+"}</Text>
            <Text style={{ color: "#2DD4BF", fontSize: 14, fontWeight: "600" }}>Add Stop ({extraStops.length + 1}/3 destinations)</Text>
          </TouchableOpacity>
        )}

        <Text style={s.sectionTitle}>OR PIN DROPOFF ON MAP</Text>
        <View style={s.pinRow}>
          <TouchableOpacity
            style={[s.pinBtn, { backgroundColor: pinMode === "dropoff" ? "#e91e63" : "#2a1a1a", borderWidth: 1, borderColor: "#e91e63", flex: 1 }]}
            onPress={() => setPinMode(pinMode === "dropoff" ? null : "dropoff")}>
            <Text style={{ color: "#F4F6FB", fontWeight: "700" }}>{pinMode === "dropoff" ? "Tap map..." : "Pin Dropoff"}</Text>
          </TouchableOpacity>
        </View>

        <WebView
          style={{ width: "100%", height: 300, borderRadius: 12, marginBottom: 12 }}
          onMessage={async (e) => {
            try {
              const d = JSON.parse(e.nativeEvent.data);
              setDropoffText("Locating address...");
              setDropoffPin({ latitude: d.lat, longitude: d.lng });
              const address = await reverseGeocode(d.lat, d.lng);
              setDropoffText(address);
              if (pickupPin) {
                if (extraStops.some(s => s.pin)) recalcMultiStopFare(pickupPin, { latitude: d.lat, longitude: d.lng });
                else updateFare(pickupPin.latitude, pickupPin.longitude, d.lat, d.lng);
              }
            } catch (err) { }
          }}
          source={{
            html: `<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"/><script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script><style>html,body,#map{height:100%;margin:0}.leaflet-popup-content-wrapper{background:#131C2E;color:#F4F6FB;border-radius:10px}.leaflet-popup-tip{background:#131C2E}</style></head><body><div id="map"></div><script>var map=L.map("map",{attributionControl:false}).setView([${pickupPin?.latitude || location?.latitude || 6.6},${pickupPin?.longitude || location?.longitude || -0.9}],14);L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",{maxZoom:19}).addTo(map);var pickIcon=L.divIcon({html:'<svg width="34" height="42" viewBox="0 0 34 42" xmlns="http://www.w3.org/2000/svg"><path d="M17 0C7.6 0 0 7.6 0 17c0 12 17 25 17 25s17-13 17-25C34 7.6 26.4 0 17 0z" fill="#2DD4BF"/><circle cx="17" cy="17" r="6" fill="#0B1220"/></svg>',iconSize:[34,42],iconAnchor:[17,42],className:"pk"});var dropIcon=L.divIcon({html:'<svg width="34" height="42" viewBox="0 0 34 42" xmlns="http://www.w3.org/2000/svg"><path d="M17 0C7.6 0 0 7.6 0 17c0 12 17 25 17 25s17-13 17-25C34 7.6 26.4 0 17 0z" fill="#F5A623"/><circle cx="17" cy="17" r="6" fill="#0B1220"/></svg>',iconSize:[34,42],iconAnchor:[17,42],className:"dp"});${pickupPin ? `L.marker([${pickupPin.latitude},${pickupPin.longitude}],{icon:pickIcon}).addTo(map).bindPopup("Pickup");` : ""}var dk=null;map.on("click",function(e){if(dk)map.removeLayer(dk);dk=L.marker(e.latlng,{icon:dropIcon}).addTo(map).bindPopup("Dropoff").openPopup();window.ReactNativeWebView.postMessage(JSON.stringify({type:"dropoff",lat:e.latlng.lat,lng:e.latlng.lng}));});</script></body></html>`
          }}
        />

        {estFare && (
          <View style={s.fareBox}>
            <Text style={{ color: "#2DD4BF", fontWeight: "bold", fontSize: 16, textAlign: "center" }}>Estimated Fare</Text>
            <Text style={{ color: "#F4F6FB", fontSize: 32, fontWeight: "bold", textAlign: "center", marginTop: 4 }}>GHS {estFare}</Text>
            <Text style={{ color: "#8A9BB8", textAlign: "center", marginTop: 4 }}>{estKm} km</Text>
            <View style={{ flexDirection: "row", justifyContent: "center", gap: 8, marginTop: 6 }}>
              <Text style={{ color: getSurgeLabel(driverBookings.filter(b => b.status === "pending").length).color, fontSize: 11, fontWeight: "bold" }}>
                {getSurgeLabel(driverBookings.filter(b => b.status === "pending").length).label}
              </Text>
              {getNightMultiplier().multiplier > 1.0 && (
                <Text style={{ color: getNightMultiplier().color, fontSize: 11, fontWeight: "bold" }}>
                  • {getNightMultiplier().label}
                </Text>
              )}
            </View>
          </View>
        )}

        {scheduleRide && (
          <>
            <Text style={s.sectionTitle}>WHEN SHOULD THE RIDE BE?</Text>
            <Text style={{ color: "#8A9BB8", fontSize: 12, marginBottom: 8 }}>Select day (up to 7 days ahead):</Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 12 }}>
              <View style={{ flexDirection: "row", gap: 8 }}>
                {getNext7Days().map(d => (
                  <TouchableOpacity
                    key={d.key}
                    onPress={() => { setScheduledDay(d.key); setScheduledTime(null); }}
                    style={{ paddingVertical: 10, paddingHorizontal: 14, borderRadius: 8, backgroundColor: scheduledDay === d.key ? "#2DD4BF" : "#131C2E", borderWidth: 1, borderColor: scheduledDay === d.key ? "#2DD4BF" : "#333", alignItems: "center" }}>
                    <Text style={{ color: scheduledDay === d.key ? "#000" : "#F4F6FB", fontSize: 13, fontWeight: "bold" }}>{d.label}</Text>
                    <Text style={{ color: scheduledDay === d.key ? "#000" : "#8A9BB8", fontSize: 11 }}>{d.date}</Text>
                  </TouchableOpacity>
                ))}
              </View>
            </ScrollView>

            {scheduledDay && (
              <>
                <Text style={{ color: "#8A9BB8", fontSize: 12, marginBottom: 8 }}>Select pickup time:</Text>
                <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 12 }}>
                  <View style={{ flexDirection: "row", gap: 8 }}>
                    {getTimeSlots(scheduledDay).map(t => (
                      <TouchableOpacity
                        key={t.key}
                        onPress={() => setScheduledTime(t.key)}
                        style={{ paddingVertical: 10, paddingHorizontal: 14, borderRadius: 8, backgroundColor: scheduledTime === t.key ? "#2DD4BF" : "#131C2E", borderWidth: 1, borderColor: scheduledTime === t.key ? "#2DD4BF" : "#333" }}>
                        <Text style={{ color: scheduledTime === t.key ? "#000" : "#F4F6FB", fontSize: 13, fontWeight: scheduledTime === t.key ? "bold" : "normal" }}>{t.label}</Text>
                      </TouchableOpacity>
                    ))}
                  </View>
                </ScrollView>
                {scheduledTime && (
                  <View style={{ backgroundColor: "#1a2a1a", borderRadius: 10, padding: 12, marginBottom: 12, borderWidth: 1, borderColor: "#2DD4BF" }}>
                    <Text style={{ color: "#2DD4BF", fontWeight: "bold", textAlign: "center" }}>
                      <Ionicons name="calendar" size={14} color="#5B8FE0" /> Scheduled for {getNext7Days().find(d => d.key === scheduledDay)?.label} at {getTimeSlots(scheduledDay).find(t => t.key === scheduledTime)?.label}
                    </Text>
                  </View>
                )}
              </>
            )}
          </>
        )}

        <TouchableOpacity
          onPress={() => setShowMoreBookingOptions(!showMoreBookingOptions)}
          style={[s.card, { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: showMoreBookingOptions ? 12 : 16 }]}>
          <View>
            <Text style={{ color: "#F4F6FB", fontWeight: "700" }}>More Options</Text>
            <Text style={{ color: "#8A9BB8", fontSize: 12, marginTop: 2 }}>
              {bookingForSomeoneElse ? `For ${recipientName || "someone else"}` : "For myself"}
              {bookingQuantity > 1 ? ` · ${bookingQuantity} rides` : ""}
            </Text>
          </View>
          <Ionicons name={showMoreBookingOptions ? "chevron-up" : "chevron-down"} size={18} color="#8A9BB8" />
        </TouchableOpacity>

        {showMoreBookingOptions && (
          <>
            <Text style={s.sectionTitle}>WHO IS THIS RIDE FOR?</Text>
            <View style={{ flexDirection: "row", gap: 8, marginBottom: 12 }}>
              <TouchableOpacity
                onPress={() => setBookingForSomeoneElse(false)}
                style={{ flex: 1, padding: 12, borderRadius: 8, backgroundColor: !bookingForSomeoneElse ? "#2DD4BF" : "#131C2E", borderWidth: 1, borderColor: !bookingForSomeoneElse ? "#2DD4BF" : "#333", alignItems: "center" }}>
                <Text style={{ color: !bookingForSomeoneElse ? "#000" : "#F4F6FB", fontWeight: "700" }}>Myself</Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={() => setBookingForSomeoneElse(true)}
                style={{ flex: 1, padding: 12, borderRadius: 8, backgroundColor: bookingForSomeoneElse ? "#2DD4BF" : "#131C2E", borderWidth: 1, borderColor: bookingForSomeoneElse ? "#2DD4BF" : "#333", alignItems: "center" }}>
                <Text style={{ color: bookingForSomeoneElse ? "#000" : "#F4F6FB", fontWeight: "700" }}>Someone Else</Text>
              </TouchableOpacity>
            </View>
            {bookingForSomeoneElse && (
              <View style={[s.card, { marginBottom: 12 }]}>
                <Text style={{ color: "#8A9BB8", fontSize: 12, marginBottom: 10 }}>
                  We'll pass their name and number to the driver, and text them the ride details if they're on Luma too.
                </Text>
                <TextInput style={s.input} placeholder="Their name (e.g. your son, a relative)" placeholderTextColor="#5A6B85" value={recipientName} onChangeText={setRecipientName} />
                <TextInput style={[s.input, { marginBottom: 0 }]} placeholder="Their phone number" placeholderTextColor="#5A6B85" value={recipientPhone} onChangeText={setRecipientPhone} keyboardType="phone-pad" />
              </View>
            )}

            <Text style={s.sectionTitle}>HOW MANY RIDES?</Text>
            <Text style={{ color: "#8A9BB8", fontSize: 12, marginBottom: 10 }}>
              Going out with friends and need more than one car? Book several rides — same pickup and drop-off, dispatched to separate drivers, one at a time.
            </Text>
            <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 20, marginBottom: 16 }}>
              <TouchableOpacity
                onPress={() => setBookingQuantity(Math.max(1, bookingQuantity - 1))}
                style={{ width: 44, height: 44, borderRadius: 22, backgroundColor: "#131C2E", borderWidth: 1, borderColor: "#333", alignItems: "center", justifyContent: "center" }}>
                <Ionicons name="remove" size={20} color="#2DD4BF" />
              </TouchableOpacity>
              <Text style={{ color: "#F4F6FB", fontSize: 22, fontWeight: "bold", minWidth: 40, textAlign: "center" }}>{bookingQuantity}</Text>
              <TouchableOpacity
                onPress={() => setBookingQuantity(Math.min(6, bookingQuantity + 1))}
                style={{ width: 44, height: 44, borderRadius: 22, backgroundColor: "#131C2E", borderWidth: 1, borderColor: "#333", alignItems: "center", justifyContent: "center" }}>
                <Ionicons name="add" size={20} color="#2DD4BF" />
              </TouchableOpacity>
            </View>
            {bookingQuantity > 1 && (
              <Text style={{ color: "#F5A623", fontSize: 12, textAlign: "center", marginBottom: 4 }}>
                This will create {bookingQuantity} separate ride requests, GHS {estFare ? (estFare * bookingQuantity) : "—"} total.
              </Text>
            )}
          </>
        )}

        <Text style={s.sectionTitle}>PAYMENT METHOD</Text>
        <View style={{ flexDirection: "row", gap: 8, marginBottom: 12 }}>
          {[["cash", "cash-outline", "Cash"], ["momo", "phone-portrait-outline", "MoMo"], ["card", "card-outline", "Card"]].map(([val, icon, label]) => (
            <TouchableOpacity
              key={val as string}
              onPress={() => setPaymentMethod(val as string)}
              style={{ flex: 1, padding: 12, borderRadius: 8, backgroundColor: paymentMethod === val ? "#2DD4BF" : "#131C2E", borderWidth: 1, borderColor: paymentMethod === val ? "#2DD4BF" : "#333", alignItems: "center" }}>
              <Ionicons name={icon as any} size={24} color={paymentMethod === val ? "#000" : "#F4F6FB"} />
              <Text style={{ color: paymentMethod === val ? "#000" : "#F4F6FB", fontSize: 12, fontWeight: paymentMethod === val ? "bold" : "normal", marginTop: 4 }}>{label}</Text>
            </TouchableOpacity>
          ))}
        </View>

        <Text style={s.sectionTitle}>PROMO CODE</Text>
        {!promoApplied ? (
          <>
            <View style={{ flexDirection: "row", gap: 8, marginBottom: 4 }}>
              <TextInput
                style={[s.input, { flex: 1, marginBottom: 0 }]}
                placeholder="Enter promo or referral code..."
                placeholderTextColor="#5A6B85"
                value={promoCode}
                onChangeText={t => { setPromoCode(t.toUpperCase()); setPromoError(""); }}
                autoCapitalize="characters"
              />
              <TouchableOpacity style={[s.btn, { marginTop: 0, paddingHorizontal: 16 }]} onPress={applyPromoCode}>
                <Text style={s.btnTxt}>Apply</Text>
              </TouchableOpacity>
            </View>
            {promoError ? <Text style={{ color: "#F87171", fontSize: 12, marginBottom: 8 }}>{promoError}</Text> : null}
          </>
        ) : (
          <View style={{ backgroundColor: "#1a3a1a", borderRadius: 10, padding: 12, marginBottom: 12, borderWidth: 1, borderColor: "#2DD4BF", flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
            <View>
              <Text style={{ color: "#2DD4BF", fontWeight: "bold" }}><Ionicons name="checkmark-circle" size={16} color="#2DD4BF" /> Promo Applied!</Text>
              <Text style={{ color: "#8A9BB8", fontSize: 12 }}>{promoApplied.label}</Text>
              {estFare && promoApplied.discount > 0 && (
                <Text style={{ color: "#2DD4BF", fontWeight: "bold", marginTop: 4 }}>
                  {promoApplied.discount >= 100 ? "FREE RIDE" : `GHS ${calcDiscountedFare(estFare)} (was GHS ${estFare})`}
                </Text>
              )}
            </View>
            <TouchableOpacity onPress={removePromo}>
              <Text style={{ color: "#F87171", fontSize: 13 }}>Remove</Text>
            </TouchableOpacity>
          </View>
        )}

        {submittingRide || submittingBulkBooking ? (
          <Pulse label={bookingQuantity > 1 ? `Booking ${bookingQuantity} rides...` : "Booking your ride..."} size={32} />
        ) : (
          <TouchableOpacity style={[s.btn, { marginTop: 8 }]} onPress={submitRide}>
            <Text style={s.btnTxt}>
              <Ionicons name="car-sport" size={16} color="#000" /> {
                bookingQuantity > 1
                  ? `Book ${bookingQuantity} Rides`
                  : promoApplied?.discount >= 100 ? "Book FREE Ride" : estFare && promoApplied ? `Book — GHS ${calcDiscountedFare(estFare)}` : "Confirm Booking"
              }
            </Text>
          </TouchableOpacity>
        )}
      </ScrollView>
    </SafeAreaView>
  );

  // CLIENT PROFILE — identity, bookings, favourites, home address, referral
  if (screen === "clientProfile") return (
    <SafeAreaView style={s.safe}>
      <View style={s.nav}>
        <TouchableOpacity onPress={() => go("clientHome")}><Text style={s.navLink}>Back</Text></TouchableOpacity>
        <Text style={s.navLogo}>Profile</Text>
        <View />
      </View>
      <ScrollView contentContainerStyle={{ padding: 20 }}>
        <View style={s.card}>
          <TouchableOpacity onPress={uploadProfilePhoto} style={{ alignSelf: "center", marginBottom: 12 }}>
            <View style={{ width: 88, height: 88, borderRadius: 44, backgroundColor: "#2DD4BF18", alignItems: "center", justifyContent: "center", overflow: "hidden", borderWidth: 2, borderColor: "#2DD4BF" }}>
              {user?.profilePhoto
                ? <Image source={{ uri: user.profilePhoto }} style={{ width: 88, height: 88 }} />
                : <Ionicons name="person" size={40} color="#2DD4BF" />}
            </View>
            <View style={{ position: "absolute", bottom: 0, right: 0, width: 30, height: 30, borderRadius: 15, backgroundColor: "#2DD4BF", alignItems: "center", justifyContent: "center", borderWidth: 2, borderColor: "#131C2E" }}>
              <Ionicons name={uploadingPhoto ? "hourglass" : "camera"} size={15} color="#04231F" />
            </View>
          </TouchableOpacity>
          <Text style={[s.cardTitle, { textAlign: "center" }]}>{user?.name}</Text>
          <Text style={[s.cardSub, { textAlign: "center" }]}>{user?.email}</Text>
          <Text style={[s.cardSub, { textAlign: "center" }]}>{user?.phone}</Text>
          <View style={[s.badge, { backgroundColor: "#1a3a1a", marginTop: 8, alignSelf: "center" }]}>
            <Text style={{ color: "#2DD4BF", fontSize: 12 }}><Ionicons name="checkmark-circle" size={16} color="#2DD4BF" /> Verified Client</Text>
          </View>
          <TouchableOpacity
            style={[s.btnOut, { marginTop: 12 }]}
            onPress={() => { setEditName(user?.name || ""); setEditPhone(user?.phone || ""); go("editProfile"); }}>
            <Text style={s.btnOutTxt}><Ionicons name="pencil" size={14} color="#2DD4BF" /> Edit Profile</Text>
          </TouchableOpacity>
        </View>

        <Text style={s.sectionTitle}>ACCOUNT</Text>
        <TouchableOpacity style={s.card} onPress={() => go("myBookings")}>
          <Text style={s.cardTitle}><Ionicons name="clipboard" size={18} color="#2DD4BF" /> My Bookings</Text>
          <Text style={s.cardSub}>View all your rides and orders</Text>
        </TouchableOpacity>
        {favouriteDrivers.length > 0 && (
          <View style={s.card}>
            <Text style={s.cardTitle}><Ionicons name="star" size={16} color="#2DD4BF" /> Favourite Drivers ({favouriteDrivers.length}/5)</Text>
            {favouriteDrivers.map((f, i) => (
              <View key={i} style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginTop: 8 }}>
                <Text style={{ color: "#F4F6FB" }}>{f.driver_name || "Driver"}</Text>
                <TouchableOpacity onPress={() => removeFavouriteDriver(f.id, f.driver_name || "Driver")}>
                  <Text style={{ color: "#F87171", fontSize: 12 }}>Remove</Text>
                </TouchableOpacity>
              </View>
            ))}
          </View>
        )}

        <Text style={s.sectionTitle}>HOME ADDRESS</Text>
        {homeAddress ? (
          <View style={[s.card, { borderColor: "#2DD4BF", borderWidth: 1, flexDirection: "row", alignItems: "center" }]}>
            <View style={{ width: 46, height: 46, borderRadius: 23, backgroundColor: "#2DD4BF22", alignItems: "center", justifyContent: "center", marginRight: 14 }}>
              <Ionicons name="home" size={22} color="#2DD4BF" />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={s.cardTitle}>Home</Text>
              <Text style={s.cardSub} numberOfLines={2}>{homeAddress.text}</Text>
            </View>
            <TouchableOpacity onPress={removeHomeAddress}>
              <Text style={{ color: "#F87171", fontSize: 12 }}>Remove</Text>
            </TouchableOpacity>
          </View>
        ) : (
          <View style={s.card}>
            <Text style={s.cardSub}>Save your home address once, and it'll show up as a one-tap dropoff suggestion every time you book a ride.</Text>
            <TextInput
              style={[s.input, { marginTop: 12 }]}
              placeholder="Search your home address..."
              placeholderTextColor="#5A6B85"
              value={homeAddressInput}
              onChangeText={async (t) => {
                setHomeAddressInput(t);
                if (t.length >= 3) setHomeAddressSugg(await searchPlaces(t));
                else setHomeAddressSugg([]);
              }}
            />
            {homeAddressSugg.length > 0 && (
              <View style={s.suggestBox}>
                {homeAddressSugg.map((p, i) => (
                  <TouchableOpacity key={i} style={s.suggestItem} onPress={() => {
                    saveHomeAddress(p.name, p.lat, p.lon);
                    setHomeAddressInput(""); setHomeAddressSugg([]);
                  }}>
                    <Text style={s.suggestTxt}><Ionicons name="location" size={13} color="#2DD4BF" style={{ marginRight: 4 }} /> {p.name.length > 60 ? p.name.substring(0, 60) + "..." : p.name}</Text>
                  </TouchableOpacity>
                ))}
              </View>
            )}
            <TouchableOpacity
              style={[s.btnOut, { marginTop: 4 }]}
              onPress={async () => {
                if (!location) { showAlert("Location unavailable", "Please search for your address manually instead."); return; }
                const address = await reverseGeocode(location.latitude, location.longitude);
                saveHomeAddress(address, location.latitude, location.longitude);
              }}>
              <Text style={s.btnOutTxt}><Ionicons name="locate" size={14} color="#2DD4BF" /> Use My Current Location</Text>
            </TouchableOpacity>
          </View>
        )}

        <View style={[s.card, { borderColor: "#2DD4BF", borderWidth: 1 }]}>
          <Text style={s.cardTitle}><Ionicons name="gift" size={18} color="#2DD4BF" /> Referral Code</Text>
          <Text style={{ color: "#2DD4BF", fontSize: 16, fontWeight: "bold", marginTop: 4 }}>{user?.referralCode || "Loading..."}</Text>
          <Text style={s.cardSub}>Share this — earn GHS 5 per friend who completes their first ride</Text>
          {promoCredit > 0 && (
            <Text style={{ color: "#2DD4BF", fontWeight: "bold", marginTop: 8 }}>Current credit: GHS {promoCredit}</Text>
          )}
        </View>

        <TouchableOpacity style={[s.btnOut, { marginTop: 8 }]} onPress={logout}>
          <Text style={s.btnOutTxt}>Log Out</Text>
        </TouchableOpacity>
      </ScrollView>
    </SafeAreaView>
  );

  // HELP & SUPPORT — real screen with FAQ and contact options, shared by client and driver
  if (screen === "helpSupport") {
    const isDriverRole = ["car_driver", "tuktuk_driver", "motorbike_rider", "restaurant", "driver", "home_service"].includes(user?.role);
    const faqs = [
      { q: "How do cancellations work?", a: "Cancelling before a driver accepts is always free. Within 3 minutes of acceptance is also free. After that, a small fee may apply — GHS 5 if the driver hasn't arrived yet, GHS 10 if they have." },
      { q: "How do I pay for a ride?", a: "Choose Cash, Mobile Money, or Card when booking. Cash is paid directly to your driver. MoMo and Card are charged automatically once the ride is marked complete — never before." },
      { q: "I left something in the vehicle — what now?", a: "Go to Settings → Lost & Found and report it from your ride history. Your driver is notified immediately and can confirm if they've found it." },
      { q: "How does the SOS button work?", a: "Hold the SOS button for 3 seconds during any active ride. After a 3-second countdown (which you can cancel), your location is shared with Luma admin and your saved emergency contacts are notified." },
      { q: "How do refunds work?", a: "If something goes wrong with a paid (MoMo/Card) order, request a refund from Settings → Refund Requests. An admin reviews it and you can track the status there." },
      { q: "How do I become a driver?", a: "Log out and choose \"Create Account\" from the welcome screen, then select your role. Verification is quick — most applications are approved within a few hours." },
    ];
    return (
      <SafeAreaView style={s.safe}>
        <View style={s.nav}>
          <TouchableOpacity onPress={() => go(isDriverRole ? "driverProfile" : "clientSettings")}><Text style={s.navLink}>Back</Text></TouchableOpacity>
          <Text style={s.navLogo}>Help & Support</Text>
          <View />
        </View>
        <ScrollView contentContainerStyle={{ padding: 20 }}>
          <Text style={s.sectionTitle}>CONTACT US</Text>
          <TouchableOpacity style={[s.card, { flexDirection: "row", alignItems: "center" }]} onPress={() => Linking.openURL("mailto:luminalinks43@gmail.com")}>
            <View style={{ width: 46, height: 46, borderRadius: 23, backgroundColor: "#2DD4BF22", alignItems: "center", justifyContent: "center", marginRight: 14 }}>
              <Ionicons name="mail" size={22} color="#2DD4BF" />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={s.cardTitle}>Email</Text>
              <Text style={s.cardSub}>luminalinks43@gmail.com</Text>
            </View>
            <Ionicons name="chevron-forward" size={18} color="#2DD4BF" />
          </TouchableOpacity>
          <TouchableOpacity style={[s.card, { flexDirection: "row", alignItems: "center" }]} onPress={() => Linking.openURL("tel:0257638694")}>
            <View style={{ width: 46, height: 46, borderRadius: 23, backgroundColor: "#2DD4BF22", alignItems: "center", justifyContent: "center", marginRight: 14 }}>
              <Ionicons name="call" size={22} color="#2DD4BF" />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={s.cardTitle}>Phone</Text>
              <Text style={s.cardSub}>0257 638 694</Text>
            </View>
            <Ionicons name="chevron-forward" size={18} color="#2DD4BF" />
          </TouchableOpacity>
          <Text style={{ color: "#5A6B85", fontSize: 12, marginTop: 4, marginBottom: 4 }}>Support is available every day. Response times may be longer late at night.</Text>

          <Text style={s.sectionTitle}>FREQUENTLY ASKED QUESTIONS</Text>
          {faqs.map((item, i) => (
            <View key={i} style={s.card}>
              <Text style={s.cardTitle}>{item.q}</Text>
              <Text style={[s.cardSub, { marginTop: 6, lineHeight: 19 }]}>{item.a}</Text>
            </View>
          ))}

          <TouchableOpacity style={[s.card, { flexDirection: "row", alignItems: "center" }]} onPress={() => go(isDriverRole ? "emergencyContacts" : "emergencyContacts")}>
            <View style={{ width: 46, height: 46, borderRadius: 23, backgroundColor: "#F8717122", alignItems: "center", justifyContent: "center", marginRight: 14 }}>
              <Ionicons name="shield-checkmark" size={22} color="#F87171" />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={s.cardTitle}>Safety Center</Text>
              <Text style={s.cardSub}>Manage emergency contacts and safety settings</Text>
            </View>
            <Ionicons name="chevron-forward" size={18} color="#F87171" />
          </TouchableOpacity>
        </ScrollView>
      </SafeAreaView>
    );
  }

  // ABOUT LUMA — real screen with mission, offerings, and version info
  if (screen === "aboutLuma") {
    const isDriverRole = ["car_driver", "tuktuk_driver", "motorbike_rider", "restaurant", "driver", "home_service"].includes(user?.role);
    return (
      <SafeAreaView style={s.safe}>
        <View style={s.nav}>
          <TouchableOpacity onPress={() => go(isDriverRole ? "driverProfile" : "clientSettings")}><Text style={s.navLink}>Back</Text></TouchableOpacity>
          <Text style={s.navLogo}>About Luma</Text>
          <View />
        </View>
        <ScrollView contentContainerStyle={{ padding: 20, alignItems: "center" }}>
          <View style={{ marginTop: 8, marginBottom: 4 }}><Wordmark fontSize={30} /></View>
          <Text style={{ color: "#8A9BB8", fontSize: 13, marginBottom: 24, textAlign: "center" }}>Ghana's Own Super App</Text>

          <View style={[s.card, { width: "100%" }]}>
            <Text style={s.cardTitle}>Our Mission</Text>
            <Text style={[s.cardSub, { marginTop: 6, lineHeight: 19 }]}>
              Uber, Bolt, and similar apps mostly serve Accra and Kumasi — millions of people in Ghana's smaller towns are left out. Luma exists to bring reliable, affordable rides and delivery to every town in Ghana, starting right here in Asamankese.
            </Text>
          </View>

          <View style={[s.card, { width: "100%" }]}>
            <Text style={s.cardTitle}>What Luma Offers</Text>
            {[
              ["car-sport", "Car Rides", "Point-to-point rides in private cars"],
              ["car", "Tuk Tuk", "Affordable short-distance local trips"],
              ["bicycle", "Motorbike Delivery", "Fast parcel and errand delivery"],
              ["fast-food", "Food Delivery", "Order from local restaurants and vendors"],
            ].map(([icon, title, sub]) => (
              <View key={title as string} style={{ flexDirection: "row", alignItems: "center", marginTop: 12 }}>
                <View style={{ width: 38, height: 38, borderRadius: 19, backgroundColor: "#2DD4BF22", alignItems: "center", justifyContent: "center", marginRight: 12 }}>
                  <Ionicons name={icon as any} size={18} color="#2DD4BF" />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={{ color: "#F4F6FB", fontSize: 14, fontWeight: "600" }}>{title}</Text>
                  <Text style={{ color: "#8A9BB8", fontSize: 12 }}>{sub}</Text>
                </View>
              </View>
            ))}
          </View>

          <View style={[s.card, { width: "100%" }]}>
            <Text style={s.cardTitle}>Built in Ghana</Text>
            <Text style={[s.cardSub, { marginTop: 6, lineHeight: 19 }]}>
              Luma is founded by Lumina, a student at Presec Legon in Asamankese, Eastern Region — proof that age and location aren't a barrier to building something that serves your whole community.
            </Text>
          </View>

          <TouchableOpacity style={[s.card, { width: "100%" }]} onPress={() => showAlert("Legal", "Full Terms of Service and Privacy Policy will be published here ahead of launch.")}>
            <Text style={s.cardTitle}><Ionicons name="document-text" size={16} color="#2DD4BF" /> Terms & Privacy</Text>
            <Text style={s.cardSub}>Coming soon</Text>
          </TouchableOpacity>

          <Text style={{ color: "#5A6B85", fontSize: 12, marginTop: 12 }}>Version 1.0.0</Text>
        </ScrollView>
      </SafeAreaView>
    );
  }

  // CLIENT SETTINGS — payment preference, notifications, safety setup, support
  if (screen === "clientSettings") return (
    <SafeAreaView style={s.safe}>
      <View style={s.nav}>
        <TouchableOpacity onPress={() => go("clientHome")}><Text style={s.navLink}>Back</Text></TouchableOpacity>
        <Text style={s.navLogo}>Settings</Text>
        <View />
      </View>
      <ScrollView contentContainerStyle={{ padding: 20 }}>
        <Text style={s.sectionTitle}>PAYMENT PREFERENCE</Text>
        <View style={s.card}>
          <Text style={s.cardSub}>Default payment method for new bookings</Text>
          <View style={{ flexDirection: "row", gap: 8, marginTop: 10 }}>
            {[["cash", "cash-outline", "Cash"], ["momo", "phone-portrait-outline", "MoMo"], ["card", "card-outline", "Card"]].map(([val, icon, label]) => (
              <TouchableOpacity
                key={val as string}
                onPress={() => setPaymentMethod(val as string)}
                style={{ flex: 1, padding: 10, borderRadius: 8, backgroundColor: paymentMethod === val ? "#2DD4BF" : "#131C2E", borderWidth: 1, borderColor: paymentMethod === val ? "#2DD4BF" : "#333", alignItems: "center" }}>
                <Ionicons name={icon as any} size={20} color={paymentMethod === val ? "#000" : "#F4F6FB"} />
                <Text style={{ color: paymentMethod === val ? "#000" : "#F4F6FB", fontSize: 11, fontWeight: paymentMethod === val ? "bold" : "normal", marginTop: 4 }}>{label}</Text>
              </TouchableOpacity>
            ))}
          </View>
        </View>

        <Text style={s.sectionTitle}>NOTIFICATIONS</Text>
        <View style={s.card}>
          <View style={s.onlineRow}>
            <Text style={{ color: "#F4F6FB", fontSize: 13 }}>Push Notifications</Text>
            <Switch value={pushNotifsEnabled} onValueChange={(v) => saveNotifPref("notif_push", v, setPushNotifsEnabled)} trackColor={{ false: "#333", true: "#2DD4BF" }} thumbColor="#F4F6FB" />
          </View>
          <View style={[s.onlineRow, { marginTop: 8 }]}>
            <Text style={{ color: "#F4F6FB", fontSize: 13 }}>Ride Status Updates</Text>
            <Switch value={rideUpdatesEnabled} onValueChange={(v) => saveNotifPref("notif_rides", v, setRideUpdatesEnabled)} trackColor={{ false: "#333", true: "#2DD4BF" }} thumbColor="#F4F6FB" />
          </View>
          <View style={[s.onlineRow, { marginTop: 8 }]}>
            <Text style={{ color: "#F4F6FB", fontSize: 13 }}>Promos & Offers</Text>
            <Switch value={promoNotifsEnabled} onValueChange={(v) => saveNotifPref("notif_promos", v, setPromoNotifsEnabled)} trackColor={{ false: "#333", true: "#2DD4BF" }} thumbColor="#F4F6FB" />
          </View>
        </View>

        <Text style={s.sectionTitle}>SAFETY & TRACKING</Text>
        <TouchableOpacity style={[s.card, { flexDirection: "row", alignItems: "center" }]} onPress={() => go("emergencyContacts")}>
          <View style={{ width: 46, height: 46, borderRadius: 23, backgroundColor: "#F8717122", alignItems: "center", justifyContent: "center", marginRight: 14 }}>
            <Ionicons name="shield-checkmark" size={22} color="#F87171" />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={s.cardTitle}>Safety & Emergency Contacts</Text>
            <Text style={s.cardSub}>Add people to be notified if you use SOS</Text>
          </View>
          <Ionicons name="chevron-forward" size={18} color="#F87171" />
        </TouchableOpacity>
        <TouchableOpacity style={[s.card, { flexDirection: "row", alignItems: "center" }]} onPress={() => go("myLostItems")}>
          <View style={{ width: 46, height: 46, borderRadius: 23, backgroundColor: "#5B8FE022", alignItems: "center", justifyContent: "center", marginRight: 14 }}>
            <Ionicons name="search" size={22} color="#5B8FE0" />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={s.cardTitle}>Lost & Found</Text>
            <Text style={s.cardSub}>Track items you've reported leaving behind</Text>
          </View>
          <Ionicons name="chevron-forward" size={18} color="#5B8FE0" />
        </TouchableOpacity>
        <TouchableOpacity style={[s.card, { flexDirection: "row", alignItems: "center" }]} onPress={() => go("myRefundRequests")}>
          <View style={{ width: 46, height: 46, borderRadius: 23, backgroundColor: "#5B8FE022", alignItems: "center", justifyContent: "center", marginRight: 14 }}>
            <Ionicons name="cash-outline" size={22} color="#5B8FE0" />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={s.cardTitle}>Refund Requests</Text>
            <Text style={s.cardSub}>Track the status of any refunds you've requested</Text>
          </View>
          <Ionicons name="chevron-forward" size={18} color="#5B8FE0" />
        </TouchableOpacity>

        <Text style={s.sectionTitle}>SUPPORT</Text>
        <TouchableOpacity style={s.card} onPress={() => go("helpSupport")}>
          <Text style={s.cardTitle}><Ionicons name="chatbubble" size={18} color="#2DD4BF" /> Help & Support</Text>
          <Text style={s.cardSub}>FAQs, contact options, and how things work</Text>
        </TouchableOpacity>
        <TouchableOpacity style={s.card} onPress={() => go("aboutLuma")}>
          <Text style={s.cardTitle}><Ionicons name="information-circle" size={18} color="#2DD4BF" /> About Luma</Text>
          <Text style={s.cardSub}>Our mission, what we offer, and version info</Text>
        </TouchableOpacity>
      </ScrollView>
    </SafeAreaView>
  );

  // HOURLY HIRE
  if (screen === "hourlyHire") return (
    <SafeAreaView style={s.safe}>
      <View style={s.nav}>
        <TouchableOpacity onPress={() => go("clientHome")}><Text style={s.navLink}>Back</Text></TouchableOpacity>
        <Text style={s.navLogo}>Hourly Hire</Text>
        <View />
      </View>
      <ScrollView contentContainerStyle={{ padding: 16 }}>
        <Text style={{ color: "#8A9BB8", fontSize: 13, marginBottom: 16 }}>
          {hireVehicle === "motorbike"
            ? "Hire a rider by the hour for multiple parcel or food errands — not a passenger ride. Payment is made after the hire period ends."
            : "Book a vehicle by the hour for errands, waiting time, or multiple stops. Payment is made after the hire period ends."}
        </Text>

        <Text style={s.sectionTitle}>SELECT VEHICLE</Text>
        <View style={{ flexDirection: "row", gap: 8, marginBottom: 16 }}>
          {[
            ["car", "car-sport", "Car", 180],
            ["tuktuk", "car", "Tuk Tuk", 115],
            ["motorbike", "bicycle", "Delivery Rider", 80],
          ].map(([val, icon, label, rate]) => (
            <TouchableOpacity
              key={val as string}
              onPress={() => setHireVehicle(val as string)}
              style={{ flex: 1, padding: 14, borderRadius: 10, backgroundColor: hireVehicle === val ? "#2DD4BF" : "#131C2E", borderWidth: 1, borderColor: hireVehicle === val ? "#2DD4BF" : "#333", alignItems: "center" }}>
              <Ionicons name={icon as any} size={24} color={hireVehicle === val ? "#000" : "#2DD4BF"} />
              <Text style={{ color: hireVehicle === val ? "#000" : "#F4F6FB", fontWeight: "bold", marginTop: 4, textAlign: "center" }}>{label}</Text>
              <Text style={{ color: hireVehicle === val ? "#000" : "#8A9BB8", fontSize: 12 }}>GHS {rate}/hr</Text>
            </TouchableOpacity>
          ))}
        </View>

        <Text style={s.sectionTitle}>{hireVehicle === "motorbike" ? "STARTING LOCATION" : "PICKUP LOCATION"}</Text>
        <TextInput
          style={s.input}
          placeholder={hireVehicle === "motorbike" ? "Where should the rider start from?" : "Where should the driver meet you?"}
          placeholderTextColor="#5A6B85"
          value={hirePickup}
          onChangeText={async (t) => {
            setHirePickup(t);
            if (t.length >= 3) setHireSugg(await searchPlaces(t));
            else setHireSugg([]);
          }}
        />
        {hireSugg.length > 0 && (
          <View style={s.suggestBox}>
            {hireSugg.map((p, i) => (
              <TouchableOpacity key={i} style={s.suggestItem} onPress={() => { setHirePickup(p.name); setHireSugg([]); }}>
                <Text style={s.suggestTxt}><Ionicons name="location" size={13} color="#2DD4BF" style={{marginRight:4}} /> {p.name.length > 60 ? p.name.substring(0, 60) + "..." : p.name}</Text>
              </TouchableOpacity>
            ))}
          </View>
        )}

        <Text style={s.sectionTitle}>NUMBER OF HOURS</Text>
        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 20, marginBottom: 16 }}>
          <TouchableOpacity
            onPress={() => setHireHours(Math.max(1, hireHours - 1))}
            style={{ width: 44, height: 44, borderRadius: 22, backgroundColor: "#131C2E", borderWidth: 1, borderColor: "#333", alignItems: "center", justifyContent: "center" }}>
            <Text style={{ color: "#F4F6FB", fontSize: 20, fontWeight: "bold" }}>{"−"}</Text>
          </TouchableOpacity>
          <Text style={{ color: "#2DD4BF", fontSize: 32, fontWeight: "bold", minWidth: 60, textAlign: "center" }}>{hireHours}</Text>
          <TouchableOpacity
            onPress={() => setHireHours(Math.min(12, hireHours + 1))}
            style={{ width: 44, height: 44, borderRadius: 22, backgroundColor: "#131C2E", borderWidth: 1, borderColor: "#333", alignItems: "center", justifyContent: "center" }}>
            <Text style={{ color: "#F4F6FB", fontSize: 20, fontWeight: "bold" }}>{"+"}</Text>
          </TouchableOpacity>
        </View>
        <Text style={{ color: "#8A9BB8", textAlign: "center", fontSize: 12, marginBottom: 16 }}>hour{hireHours > 1 ? "s" : ""} (max 12 hours per booking)</Text>

        <View style={s.fareBox}>
          <Text style={{ color: "#2DD4BF", fontWeight: "bold", fontSize: 16, textAlign: "center" }}>Total Estimated Cost</Text>
          <Text style={{ color: "#F4F6FB", fontSize: 32, fontWeight: "bold", textAlign: "center", marginTop: 4 }}>GHS {getHireRate(hireVehicle) * hireHours}</Text>
          <Text style={{ color: "#8A9BB8", textAlign: "center", marginTop: 4 }}>GHS {getHireRate(hireVehicle)}/hour × {hireHours} hour{hireHours > 1 ? "s" : ""}</Text>
        </View>

        <View style={{ backgroundColor: "#1a2a1a", borderRadius: 10, padding: 12, marginBottom: 16, borderWidth: 1, borderColor: "#2DD4BF" }}>
          <Text style={{ color: "#2DD4BF", fontSize: 12, textAlign: "center" }}><Ionicons name="cash" size={18} color="#2DD4BF" /> Payment is collected after your hire period ends — never before.</Text>
        </View>

        {submittingHire ? (
          <Pulse label="Booking your hire..." size={32} />
        ) : (
          <TouchableOpacity style={s.btn} onPress={submitHire}>
            <Text style={s.btnTxt}><Ionicons name="time" size={16} color="#000" /> Confirm Hourly Hire</Text>
          </TouchableOpacity>
        )}
      </ScrollView>
    </SafeAreaView>
  );

  // MY BOOKINGS (CLIENT)
  if (screen === "myBookings") return (
    <SafeAreaView style={s.safe}>
      <View style={s.nav}>
        <TouchableOpacity onPress={() => go("clientHome")}><Text style={s.navLink}>Back</Text></TouchableOpacity>
        <Text style={s.navLogo}>My Bookings</Text>
        <TouchableOpacity onPress={() => go("myLostItems")}><Ionicons name="search-outline" size={22} color="#2DD4BF" /></TouchableOpacity>
      </View>
      <ScrollView
        contentContainerStyle={{ padding: 20 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => handleRefresh(fetchClientBookings)} tintColor="#2DD4BF" colors={["#2DD4BF"]} />}>
        {clientBookings.length === 0
          ? <EmptyState icon="map-outline" title="No trips yet" subtitle="Your rides, deliveries and orders will show up here. Book your first one — we'll get you moving." />
          : clientBookings.map((b, i) => (
            <View key={i} style={s.card}>
              <Text style={s.cardTitle}><Ionicons name={b.status === "scheduled" ? "calendar" : "car-sport"} size={15} color="#F4F6FB" /> {b.service === "tuktuk" ? "Tuk Tuk" : b.service === "motorbike" ? "Delivery" : "Car Ride"}{b.status === "scheduled" ? " (Scheduled)" : ""}</Text>
              {b.scheduled_for && (
                <Text style={{ color: "#5B8FE0", fontWeight: "bold", fontSize: 13, marginTop: 4 }}>
                  <Ionicons name="time" size={13} color="#5B8FE0" /> {new Date(b.scheduled_for).toLocaleDateString()} at {new Date(b.scheduled_for).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                </Text>
              )}
              <Text style={{ color: "#8A9BB8", fontSize: 13, marginTop: 4 }}><Ionicons name="location" size={13} color="#8A9BB8" /> From: {b.pickup}</Text>
              <Text style={{ color: "#8A9BB8", fontSize: 13 }}><Ionicons name="flag" size={13} color="#8A9BB8" /> To: {b.dropoff}</Text>
              <View style={{ flexDirection: "row", justifyContent: "space-between", marginTop: 8 }}>
                <Text style={{ color: "#2DD4BF", fontWeight: "bold" }}>GHS {b.price}</Text>
                <Text style={{ color: "#5A6B85", fontSize: 12 }}>
                  {b.payment_method === "momo" ? "MoMo" : b.payment_method === "card" ? "Card" : "Cash"}
                </Text>
              </View>
              <View style={[s.badge, { backgroundColor: b.status === "pending" ? "#2a2000" : b.status === "accepted" ? "#1a3a1a" : "#1a1a2a" }]}>
                <Text style={{ color: b.status === "pending" ? "#f5a623" : b.status === "accepted" ? "#2DD4BF" : "#8A9BB8", fontSize: 12 }}>
                  {b.status?.toUpperCase()}
                </Text>
              </View>
              {b.status === "accepted" && (
                <TouchableOpacity style={[s.btnGreen, { marginTop: 8 }]} onPress={() => { setActiveBookingId(b.id); go("trackRide"); }}>
                  <Text style={{ color: "#2DD4BF", fontWeight: "bold" }}>{"📍"} Track Driver Live</Text>
                </TouchableOpacity>
              )}
              {(b.status === "pending" || b.status === "accepted") && (
                <TouchableOpacity
                  style={[s.btnRed, { marginTop: 6 }]}
                  onPress={() => showAlert(
                    "Cancel Booking?",
                    b.status === "pending"
                      ? "No charge — driver hasn't accepted yet."
                      : "A cancellation fee may apply per our policy.",
                    [
                      { text: "Keep Booking", style: "cancel" },
                      { text: "Cancel Ride", style: "destructive", onPress: () => cancelBooking(b.id, true) },
                    ]
                  )}>
                  <Text style={{ color: "#F87171", fontWeight: "bold" }}>{"✕"} Cancel Booking</Text>
                </TouchableOpacity>
              )}
              {b.status === "completed" && !b.rated && (
                <TouchableOpacity style={[s.btnGreen, { marginTop: 8 }]} onPress={() => openRatingModal(b.id)}>
                  <Text style={{ color: "#2DD4BF", fontWeight: "bold" }}><Ionicons name="star" size={16} color="#2DD4BF" /> Rate Your Driver</Text>
                </TouchableOpacity>
              )}
              {b.status === "completed" && (
                <TouchableOpacity style={[s.btnOut, { marginTop: 6 }]} onPress={() => { setLostItemBookingId(b.id); go("reportLostItem"); }}>
                  <Text style={s.btnOutTxt}><Ionicons name="search" size={14} color="#2DD4BF" /> Left Something Behind?</Text>
                </TouchableOpacity>
              )}
              {b.status === "completed" && (
                <TouchableOpacity style={[s.btnGreen, { marginTop: 6 }]} onPress={() => rebookRide(b)}>
                  <Text style={{ color: "#2DD4BF", fontWeight: "bold" }}><Ionicons name="repeat" size={15} color="#2DD4BF" /> Rebook This Trip</Text>
                </TouchableOpacity>
              )}
            </View>
          ))
        }
      </ScrollView>
    </SafeAreaView>
  );

  // LOST & FOUND — REPORT AN ITEM
  // REFUNDS — REQUEST FORM
  if (screen === "requestRefund") return (
    <SafeAreaView style={s.safe}>
      <View style={s.nav}>
        <TouchableOpacity onPress={() => go("myFoodOrders")}><Text style={s.navLink}>Back</Text></TouchableOpacity>
        <Text style={s.navLogo}>Request Refund</Text>
        <View />
      </View>
      <ScrollView contentContainerStyle={{ padding: 20 }}>
        <Text style={{ color: "#8A9BB8", fontSize: 13, marginBottom: 16, lineHeight: 19 }}>
          Explain what went wrong — an admin will review your request and any evidence you provide before deciding.
        </Text>
        <TextInput
          style={[s.input, { height: 100, textAlignVertical: "top" }]}
          placeholder="e.g. Driver never showed up, food was missing items..."
          placeholderTextColor="#5A6B85"
          value={refundReason}
          onChangeText={setRefundReason}
          multiline
        />
        <Text style={s.sectionTitle}>EVIDENCE (OPTIONAL)</Text>
        <TouchableOpacity style={s.uploadBox} onPress={pickRefundEvidence}>
          {refundEvidence ? <Image source={{ uri: refundEvidence }} style={s.uploadImg} /> :
            <><Ionicons name="camera" size={36} color="#2DD4BF" /><Text style={{ color: "#8A9BB8", marginTop: 8 }}>Tap to add a photo</Text></>}
        </TouchableOpacity>
        {submittingRefund ? (
          <Pulse label="Submitting..." size={32} />
        ) : (
          <TouchableOpacity style={[s.btn, { marginTop: 16 }]} onPress={submitRefundRequest}>
            <Text style={s.btnTxt}>Submit Refund Request</Text>
          </TouchableOpacity>
        )}
      </ScrollView>
    </SafeAreaView>
  );

  // REFUNDS — MY REQUESTS
  if (screen === "myRefundRequests") return (
    <SafeAreaView style={s.safe}>
      <View style={s.nav}>
        <TouchableOpacity onPress={() => go("clientSettings")}><Text style={s.navLink}>Back</Text></TouchableOpacity>
        <Text style={s.navLogo}>Refund Requests</Text>
        <View />
      </View>
      <ScrollView contentContainerStyle={{ padding: 20 }}>
        {myRefundRequests.length === 0 ? (
          <EmptyState icon="cash-outline" title="No refund requests" subtitle="If something goes wrong with a paid order, you can request a refund from your order history." />
        ) : (
          myRefundRequests.map((r) => (
            <View key={r.id} style={s.card}>
              <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
                <Text style={s.cardTitle}>GHS {r.amount}</Text>
                <View style={[s.badge, {
                  backgroundColor: r.status === "approved" ? "#1a3a1a" : r.status === "rejected" ? "#3a1a1a" : "#2a2000"
                }]}>
                  <Text style={{ color: r.status === "approved" ? "#2DD4BF" : r.status === "rejected" ? "#F87171" : "#f5a623", fontSize: 12 }}>
                    {r.status === "approved" ? "✓ REFUNDED" : r.status === "rejected" ? "DECLINED" : "UNDER REVIEW"}
                  </Text>
                </View>
              </View>
              <Text style={s.cardSub}>{r.reason}</Text>
              {r.admin_notes && <Text style={{ color: "#8A9BB8", fontSize: 12, marginTop: 6, fontStyle: "italic" }}>Admin note: {r.admin_notes}</Text>}
              <Text style={{ color: "#5A6B85", fontSize: 11, marginTop: 8 }}>{timeAgo(r.created_at)}</Text>
            </View>
          ))
        )}
      </ScrollView>
    </SafeAreaView>
  );

  if (screen === "reportLostItem") return (
    <SafeAreaView style={s.safe}>
      <View style={s.nav}>
        <TouchableOpacity onPress={() => go("myBookings")}><Text style={s.navLink}>Back</Text></TouchableOpacity>
        <Text style={s.navLogo}>Report Lost Item</Text>
        <View />
      </View>
      <ScrollView contentContainerStyle={{ padding: 20 }}>
        <Text style={{ color: "#8A9BB8", fontSize: 13, marginBottom: 16, lineHeight: 19 }}>
          Describe what you left behind — your driver will be notified immediately and can confirm if they've found it.
        </Text>
        <TextInput
          style={[s.input, { height: 100, textAlignVertical: "top" }]}
          placeholder="e.g. Black backpack on the back seat, blue water bottle..."
          placeholderTextColor="#5A6B85"
          value={lostItemDesc}
          onChangeText={setLostItemDesc}
          multiline
        />
        <Text style={s.sectionTitle}>PHOTO (OPTIONAL)</Text>
        <TouchableOpacity style={s.uploadBox} onPress={pickLostItemPhoto}>
          {lostItemPhoto ? <Image source={{ uri: lostItemPhoto }} style={s.uploadImg} /> :
            <><Ionicons name="camera" size={36} color="#2DD4BF" /><Text style={{ color: "#8A9BB8", marginTop: 8 }}>Tap to add a photo</Text></>}
        </TouchableOpacity>
        {submittingLostItem ? (
          <Pulse label="Reporting..." size={32} />
        ) : (
          <TouchableOpacity style={[s.btn, { marginTop: 16 }]} onPress={submitLostItemReport}>
            <Text style={s.btnTxt}>Notify My Driver</Text>
          </TouchableOpacity>
        )}
      </ScrollView>
    </SafeAreaView>
  );

  // LOST & FOUND — CLIENT'S REPORTED ITEMS
  if (screen === "myLostItems") return (
    <SafeAreaView style={s.safe}>
      <View style={s.nav}>
        <TouchableOpacity onPress={() => go("clientSettings")}><Text style={s.navLink}>Back</Text></TouchableOpacity>
        <Text style={s.navLogo}>Lost & Found</Text>
        <View />
      </View>
      <ScrollView contentContainerStyle={{ padding: 20 }}>
        {myLostItems.length === 0 ? (
          <EmptyState icon="search-outline" title="Nothing reported" subtitle="If you ever leave something behind, report it from your ride history and we'll notify your driver." />
        ) : (
          myLostItems.map((item) => (
            <View key={item.id} style={s.card}>
              {item.item_photo && <Image source={{ uri: item.item_photo }} style={{ width: "100%", height: 140, borderRadius: 10, marginBottom: 10 }} />}
              <Text style={s.cardTitle}>{item.item_description}</Text>
              <View style={[s.badge, { backgroundColor: item.status === "found" ? "#1a3a1a" : "#2a2000", marginTop: 8, alignSelf: "flex-start" }]}>
                <Text style={{ color: item.status === "found" ? "#2DD4BF" : "#f5a623", fontSize: 12 }}>
                  {item.status === "found" ? "✓ FOUND — call your driver" : "REPORTED — awaiting driver"}
                </Text>
              </View>
              <Text style={{ color: "#5A6B85", fontSize: 11, marginTop: 8 }}>{timeAgo(item.created_at)}</Text>
              {item.status === "found" && item.driver_phone && (
                <TouchableOpacity style={[s.btnGreen, { marginTop: 10 }]} onPress={() => Linking.openURL(`tel:${item.driver_phone}`)}>
                  <Text style={{ color: "#2DD4BF", fontWeight: "bold" }}><Ionicons name="call" size={15} color="#2DD4BF" /> Call {item.driver_name || "Driver"}</Text>
                </TouchableOpacity>
              )}
            </View>
          ))
        )}
      </ScrollView>
    </SafeAreaView>
  );

  // LOST & FOUND — DRIVER'S REPORTS
  if (screen === "driverLostItems") return (
    <SafeAreaView style={s.safe}>
      <View style={s.nav}>
        <TouchableOpacity onPress={() => go("driverHome")}><Text style={s.navLink}>Back</Text></TouchableOpacity>
        <Text style={s.navLogo}>Lost & Found</Text>
        <View />
      </View>
      <ScrollView contentContainerStyle={{ padding: 20 }}>
        {driverLostItemReports.length === 0 ? (
          <EmptyState icon="search-outline" title="No reports" subtitle="If a client reports leaving something in your vehicle, it'll show up here." />
        ) : (
          driverLostItemReports.map((item) => (
            <View key={item.id} style={s.card}>
              {item.item_photo && <Image source={{ uri: item.item_photo }} style={{ width: "100%", height: 140, borderRadius: 10, marginBottom: 10 }} />}
              <Text style={s.cardTitle}>{item.item_description}</Text>
              <Text style={s.cardSub}>Reported by {item.client_name}</Text>
              <View style={[s.badge, { backgroundColor: item.status === "found" ? "#1a3a1a" : "#2a2000", marginTop: 8, alignSelf: "flex-start" }]}>
                <Text style={{ color: item.status === "found" ? "#2DD4BF" : "#f5a623", fontSize: 12 }}>
                  {item.status === "found" ? "✓ MARKED FOUND" : "AWAITING YOU"}
                </Text>
              </View>
              {item.status !== "found" && (
                <TouchableOpacity style={[s.btnGreen, { marginTop: 10 }]} onPress={() => markLostItemFound(item.id)}>
                  <Text style={{ color: "#2DD4BF", fontWeight: "bold" }}>✓ Mark as Found</Text>
                </TouchableOpacity>
              )}
            </View>
          ))
        )}
      </ScrollView>
    </SafeAreaView>
  );

  // TRACK RIDE (CLIENT — LIVE MAP)
  if (screen === "trackRide") {
    const activeBooking = clientBookings.find(b => b.id === activeBookingId);
    return (
      <SafeAreaView style={s.safe}>
        <View style={s.nav}>
          <TouchableOpacity onPress={() => go("myBookings")}><Text style={s.navLink}>Back</Text></TouchableOpacity>
          <Text style={s.navLogo}>Track Your Driver</Text>
          <View />
        </View>
        <ScrollView contentContainerStyle={{ padding: 16 }}>
          <View style={s.card}>
            <Text style={s.cardTitle}><Ionicons name="car-sport" size={15} color="#F4F6FB" /> {activeBooking?.service === "tuktuk" ? "Tuk Tuk" : "Car"} On The Way</Text>
            <Text style={{ color: "#8A9BB8", fontSize: 13, marginTop: 4 }}><Ionicons name="location" size={13} color="#8A9BB8" /> From: {activeBooking?.pickup}</Text>
            <Text style={{ color: "#8A9BB8", fontSize: 13 }}><Ionicons name="flag" size={13} color="#8A9BB8" /> To: {activeBooking?.dropoff}</Text>
            {driverEtaMinutes != null && (
              <View style={{ flexDirection: "row", alignItems: "center", marginTop: 10, backgroundColor: "#2DD4BF18", borderRadius: 10, paddingVertical: 8, paddingHorizontal: 12, alignSelf: "flex-start" }}>
                <Ionicons name="time" size={16} color="#2DD4BF" />
                <Text style={{ color: "#2DD4BF", fontWeight: "700", marginLeft: 6 }}>
                  {driverEtaMinutes <= 1 ? "Arriving now" : `${driverEtaMinutes} min away`}
                </Text>
              </View>
            )}
          </View>

          {assignedDriver && (
            <View style={s.card}>
              <Text style={s.sectionTitle}>YOUR DRIVER</Text>
              <View style={{ flexDirection: "row", alignItems: "center" }}>
                <View style={{ width: 52, height: 52, borderRadius: 26, backgroundColor: "#2DD4BF18", alignItems: "center", justifyContent: "center", marginRight: 14, overflow: "hidden" }}>
                  {assignedDriver.profile_photo
                    ? <Image source={{ uri: assignedDriver.profile_photo }} style={{ width: 52, height: 52 }} />
                    : <Text style={{ color: "#2DD4BF", fontSize: 22, fontWeight: "800" }}>{(assignedDriver.full_name || "D").charAt(0).toUpperCase()}</Text>}
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={{ color: "#F4F6FB", fontSize: 16, fontWeight: "700" }}>{assignedDriver.full_name || "Your Driver"}</Text>
                  <View style={{ flexDirection: "row", alignItems: "center", marginTop: 3 }}>
                    <Ionicons name="star" size={13} color="#F5A623" />
                    <Text style={{ color: "#8A9BB8", fontSize: 13, marginLeft: 4 }}>{assignedDriver.average_rating ? Number(assignedDriver.average_rating).toFixed(1) : "New driver"}</Text>
                  </View>
                </View>
                {assignedDriver.phone ? (
                  <TouchableOpacity
                    style={{ width: 44, height: 44, borderRadius: 22, backgroundColor: "#2DD4BF", alignItems: "center", justifyContent: "center" }}
                    onPress={() => Linking.openURL(`tel:${assignedDriver.phone}`)}>
                    <Ionicons name="call" size={20} color="#04231F" />
                  </TouchableOpacity>
                ) : null}
              </View>
              {assignedDriver.vehicle_photo_url && (
                <Image source={{ uri: assignedDriver.vehicle_photo_url }} style={{ width: "100%", height: 140, borderRadius: 10, marginTop: 14 }} />
              )}
              {(assignedDriver.vehicle_make || assignedDriver.vehicle_plate || assignedDriver.vehicle_color) ? (
                <View style={{ flexDirection: "row", alignItems: "center", marginTop: 14, paddingTop: 14, borderTopWidth: 1, borderTopColor: "#1B2A44" }}>
                  <Ionicons name="car" size={16} color="#8A9BB8" />
                  <Text style={{ color: "#F4F6FB", fontSize: 14, marginLeft: 8, flex: 1 }}>
                    {[assignedDriver.vehicle_color, assignedDriver.vehicle_make, assignedDriver.vehicle_model].filter(Boolean).join(" ") || "Vehicle"}
                  </Text>
                  {assignedDriver.vehicle_plate ? (
                    <View style={{ backgroundColor: "#0B1220", borderWidth: 1, borderColor: "#1B2A44", borderRadius: 8, paddingHorizontal: 10, paddingVertical: 5 }}>
                      <Text style={{ color: "#2DD4BF", fontSize: 14, fontWeight: "700", letterSpacing: 1 }}>{assignedDriver.vehicle_plate}</Text>
                    </View>
                  ) : null}
                </View>
              ) : null}
            </View>
          )}

          <Text style={s.sectionTitle}>LIVE LOCATION</Text>
          <Tappable onPress={() => openFullMap(activeBooking?.pickup, "Pickup Point", "client")} style={{ position: "relative" }}>
            <WebView
              pointerEvents="none"
              style={{ width: "100%", height: 320, borderRadius: 12, marginBottom: 12 }}
              source={{
                html: `<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"/><script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script><style>html,body,#map{height:100%;margin:0}</style></head><body><div id="map"></div><script>
                  var driverLat=${driverLiveLocation?.latitude || pickupPin?.latitude || location?.latitude || 6.6};
                  var driverLng=${driverLiveLocation?.longitude || pickupPin?.longitude || location?.longitude || -0.9};
                  var map=L.map("map",{zoomControl:false,attributionControl:false,dragging:false,scrollWheelZoom:false,doubleClickZoom:false}).setView([driverLat,driverLng],15);
                  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",{maxZoom:19}).addTo(map);
                  var driverIcon=L.divIcon({html:'<svg width="38" height="46" viewBox="0 0 38 46" xmlns="http://www.w3.org/2000/svg"><path d="M19 0C8.5 0 0 8.5 0 19c0 13.3 19 27 19 27s19-13.7 19-27C38 8.5 29.5 0 19 0z" fill="#0B1220" stroke="#2DD4BF" stroke-width="2"/><path d="M11 22.5l1.3-4c.2-.6.8-1 1.4-1h10.6c.6 0 1.2.4 1.4 1l1.3 4v5.5c0 .4-.3.7-.7.7h-1.6c-.4 0-.7-.3-.7-.7v-1H15v1c0 .4-.3.7-.7.7h-1.6c-.4 0-.7-.3-.7-.7V22.5z" fill="#2DD4BF"/><circle cx="14.5" cy="25.5" r="1.3" fill="#0B1220"/><circle cx="23.5" cy="25.5" r="1.3" fill="#0B1220"/></svg>',iconSize:[38,46],iconAnchor:[19,46],className:"driver-marker"});
                  L.marker([driverLat,driverLng],{icon:driverIcon}).addTo(map).bindPopup("Your Driver").openPopup();
                </script></body></html>`
              }}
            />
            <View style={{ position: "absolute", bottom: 12, left: 0, right: 0, alignItems: "center" }}>
              <View style={{ flexDirection: "row", alignItems: "center", backgroundColor: "#0B1220E6", paddingVertical: 8, paddingHorizontal: 14, borderRadius: 20 }}>
                <Ionicons name="navigate" size={15} color="#2DD4BF" />
                <Text style={{ color: "#F4F6FB", fontSize: 12, fontWeight: "600", marginLeft: 6 }}>Tap to view full map</Text>
              </View>
            </View>
          </Tappable>
          {driverLiveLocation
            ? <Text style={{ color: "#2DD4BF", textAlign: "center", marginBottom: 12 }}>{"●"} Live — updating every 3 seconds</Text>
            : <Text style={{ color: "#8A9BB8", textAlign: "center", marginBottom: 12 }}>Waiting for driver location...</Text>
          }

          {(() => {
            const lastMsg = chatMessages[chatMessages.length - 1];
            const hasUnread = !!lastMsg && lastMsg.sender_id !== user?.id && lastMsg.id !== lastSeenChatMessageId;
            return (
              <>
                <TouchableOpacity
                  onPress={() => { setChatOpen(!chatOpen); if (!chatOpen && lastMsg) setLastSeenChatMessageId(lastMsg.id); }}
                  style={[s.card, { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: chatOpen ? 8 : 16 }]}>
                  <View style={{ flexDirection: "row", alignItems: "center" }}>
                    <Ionicons name="chatbubble-ellipses" size={18} color="#2DD4BF" />
                    <Text style={{ color: "#F4F6FB", fontWeight: "700", marginLeft: 8 }}>Chat with Driver</Text>
                    {hasUnread && <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: "#F87171", marginLeft: 8 }} />}
                  </View>
                  <Ionicons name={chatOpen ? "chevron-up" : "chevron-down"} size={18} color="#8A9BB8" />
                </TouchableOpacity>
                {chatOpen && (
                  <>
                    <View style={{ backgroundColor: "#131C2E", borderRadius: 12, padding: 12, marginBottom: 8, minHeight: 120 }}>
                      {chatMessages.length === 0
                        ? <Text style={{ color: "#5A6B85", textAlign: "center", marginTop: 20 }}>No messages yet — say hello 👋</Text>
                        : chatMessages.map((m, i) => (
                          <View key={i} style={[s.chatBubble, { backgroundColor: m.sender_id === user?.id ? "#2DD4BF22" : "#131C2E", alignSelf: m.sender_id === user?.id ? "flex-end" : "flex-start" }]}>
                            <Text style={{ color: "#8A9BB8", fontSize: 11 }}>{m.sender_name}</Text>
                            {m.image_url
                              ? <Image source={{ uri: m.image_url }} style={{ width: 160, height: 160, borderRadius: 10, marginTop: 4 }} resizeMode="cover" />
                              : <Text style={{ color: "#F4F6FB" }}>{m.message}</Text>}
                          </View>
                        ))
                      }
                    </View>
                    <View style={{ flexDirection: "row", gap: 8, marginBottom: 16 }}>
                      <TouchableOpacity
                        style={{ width: 44, height: 44, borderRadius: 22, backgroundColor: "#131C2E", borderWidth: 1, borderColor: "#1B2A44", alignItems: "center", justifyContent: "center" }}
                        disabled={uploadingChatPhoto}
                        onPress={() => activeBookingId && sendChatPhoto(activeBookingId)}>
                        {uploadingChatPhoto ? <Ionicons name="hourglass" size={18} color="#2DD4BF" /> : <Ionicons name="camera" size={20} color="#2DD4BF" />}
                      </TouchableOpacity>
                      <TextInput style={[s.input, { flex: 1, marginBottom: 0 }]} placeholder="Type a message..." placeholderTextColor="#5A6B85" value={chatInput} onChangeText={setChatInput} />
                      <TouchableOpacity style={[s.btn, { marginTop: 0, paddingHorizontal: 16 }]} onPress={() => activeBookingId && sendMessage(activeBookingId)}>
                        <Text style={s.btnTxt}>Send</Text>
                      </TouchableOpacity>
                    </View>
                  </>
                )}
              </>
            );
          })()}

          {sosCountdown > 0 ? (
            <View style={[s.sosBtn, { backgroundColor: "#F87171", borderColor: "#F87171" }]}>
              <Text style={{ color: "#F4F6FB", fontWeight: "bold" }}>Sending SOS in {sosCountdown}...</Text>
              <TouchableOpacity onPress={cancelSosCountdown} style={{ marginTop: 6 }}>
                <Text style={{ color: "#F4F6FB", textDecorationLine: "underline" }}>Cancel</Text>
              </TouchableOpacity>
            </View>
          ) : (
            <TouchableOpacity
              style={[s.sosBtn, sosHolding && { backgroundColor: "#F87171", borderColor: "#F87171" }]}
              onPressIn={startSosHold}
              onPressOut={cancelSosHold}>
              <Text style={{ color: sosHolding ? "#F4F6FB" : "#F87171", fontWeight: "bold", fontSize: 13 }}>
                {sosHolding ? "Keep holding..." : "Hold for SOS"}
              </Text>
            </TouchableOpacity>
          )}
        </ScrollView>
      </SafeAreaView>
    );
  }

  return null;
}
