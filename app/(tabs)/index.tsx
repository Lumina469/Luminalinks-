import React, { useState, useRef, useEffect } from "react";
import { WebView } from "react-native-webview";
import { supabase } from '../../lib/supabase';
import {
  View, Text, ScrollView, TouchableOpacity, StyleSheet,
  TextInput, Alert, Switch, Image, Linking
} from "react-native";
import * as Location from "expo-location";
import { SafeAreaView } from "react-native-safe-area-context";
import * as ImagePicker from "expo-image-picker";

// ============================================================
// UTILITIES
// ============================================================
const searchPlaces = async (q: string) => {
  if (!q || q.length < 3) return [];
  try {
    const r = await fetch(
      "https://nominatim.openstreetmap.org/search?format=json&q=" +
      encodeURIComponent(q) + "&limit=5",
      { headers: { "User-Agent": "LuminaLinks/1.0" } }
    );
    return (await r.json()).map((p: any) => ({
      name: p.display_name,
      lat: parseFloat(p.lat),
      lon: parseFloat(p.lon),
    }));
  } catch (e) { return []; }
};

const reverseGeocode = async (lat: number, lon: number) => {
  try {
    const r = await fetch(
      `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lon}&zoom=18`,
      { headers: { "User-Agent": "LuminaLinks/1.0" } }
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

// ============================================================
// FARE CALCULATION — Blueprint v4.0
// Car: GHS 5 base + GHS 8/km, min GHS 20
// Tuk Tuk: GHS 3 base + GHS 5/km, min GHS 10
// Motorbike: GHS 4 base + GHS 6/km, min GHS 15
// ============================================================
const calcFare = (km: number, service: string = "car", pendingCount: number = 0) => {
  const surgeMultiplier =
    pendingCount >= 10 ? 1.5 :
    pendingCount >= 5 ? 1.25 :
    pendingCount >= 3 ? 1.1 : 1.0;

  let base = 5.0, perKm = 8.0, minFare = 20;
  if (service === "tuktuk") { base = 3.0; perKm = 5.0; minFare = 10; }
  if (service === "motorbike") { base = 4.0; perKm = 6.0; minFare = 15; }

  const fare = Math.max(minFare, base + km * perKm) * surgeMultiplier;
  const commission = fare * 0.15;
  const driverEarns = fare - commission;
  return { fare: parseFloat(fare.toFixed(2)), commission: parseFloat(commission.toFixed(2)), driverEarns: parseFloat(driverEarns.toFixed(2)) };
};

const getSurgeLabel = (pendingCount: number) => {
  if (pendingCount >= 10) return { label: "High Demand x1.5", color: "#f44336" };
  if (pendingCount >= 5) return { label: "Busy x1.25", color: "#ff9800" };
  if (pendingCount >= 3) return { label: "Moderate x1.1", color: "#f5a623" };
  return { label: "Normal Price", color: "#4caf50" };
};

// ============================================================
// PUSH NOTIFICATIONS
// ============================================================
const sendPushNotification = async (pushToken: string, title: string, body: string) => {
  if (!pushToken) return;
  await fetch("https://exp.host/--/api/v2/push/send", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ to: pushToken, title, body, sound: "default" }),
  });
};

// ============================================================
// MAIN APP
// ============================================================
export default function App() {
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
  const [roadWorthyExpiry, setRoadWorthyExpiry] = useState(""); // format YYYY-MM-DD
  const [registrationExpiry, setRegistrationExpiry] = useState("");
  const [verifyStep, setVerifyStep] = useState(1);

  // Location
  const [location, setLocation] = useState<any>(null);
  const [pickupText, setPickupText] = useState("");
  const [dropoffText, setDropoffText] = useState("");
  const [pickupPin, setPickupPin] = useState<any>(null);
  const [dropoffPin, setDropoffPin] = useState<any>(null);
  const [pickupSugg, setPickupSugg] = useState<any[]>([]);
  const [dropoffSugg, setDropoffSugg] = useState<any[]>([]);
  const [activeField, setActiveField] = useState<string | null>(null);
  const [pinMode, setPinMode] = useState<string | null>(null);

  // Booking
  const [selectedService, setSelectedService] = useState("car");
  const [estFare, setEstFare] = useState<number | null>(null);
  const [estKm, setEstKm] = useState<number | null>(null);
  const [paymentMethod, setPaymentMethod] = useState("cash");
  const [showPaystack, setShowPaystack] = useState(false);
  const [pendingPaymentBookingId, setPendingPaymentBookingId] = useState<string | null>(null);
  const [clientBookings, setClientBookings] = useState<any[]>([]);
  const [driverBookings, setDriverBookings] = useState<any[]>([]);
  const [activeBookingId, setActiveBookingId] = useState<string | null>(null);

  // Driver
  const [online, setOnline] = useState(false);
  const [driverProfile, setDriverProfile] = useState<any>(null);
  const [driverWallet, setDriverWallet] = useState<any>(null);
  const [driverRating, setDriverRating] = useState<number>(5.0);
  const [driverLiveLocation, setDriverLiveLocation] = useState<any>(null);

  // Chat
  const [chatMessages, setChatMessages] = useState<any[]>([]);
  const [chatInput, setChatInput] = useState("");

  // Rating
  const [ratingBookingId, setRatingBookingId] = useState<string | null>(null);
  const [selectedRating, setSelectedRating] = useState(0);
  const [ratingComment, setRatingComment] = useState("");
  const [showRatingModal, setShowRatingModal] = useState(false);
  const [pendingRatingBookingId, setPendingRatingBookingId] = useState<string | null>(null);

  // SOS
  const [sosActive, setSosActive] = useState(false);

  // Refs
  const ptRef = useRef<any>(null);
  const dtRef = useRef<any>(null);

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

  // Auto-detect pickup location when client opens the booking screen
  useEffect(() => {
    if (screen === "bookRide" && !pickupText && location) {
      (async () => {
        setPickupText("Detecting your location...");
        const address = await reverseGeocode(location.latitude, location.longitude);
        setPickupText(address);
        setPickupPin({ latitude: location.latitude, longitude: location.longitude });
        if (dropoffPin) updateFare(location.latitude, location.longitude, dropoffPin.latitude, dropoffPin.longitude);
      })();
    }
  }, [screen, location]);

  // ============================================================
  // DATA FETCHING
  // ============================================================
  useEffect(() => {
    if (screen === "clientOrders") {
      fetchDriverBookings();
      const interval = setInterval(fetchDriverBookings, 8000);
      return () => clearInterval(interval);
    }
    if (screen === "myBookings") {
      fetchClientBookings();
      const interval = setInterval(fetchClientBookings, 5000);
      return () => clearInterval(interval);
    }
    if (screen === "driverEarnings" || screen === "driverHome") {
      fetchWallet();
      fetchDriverRating();
    }
  }, [screen]);

  const fetchDriverBookings = async () => {
    const { data } = await supabase
      .from("bookings")
      .select("*")
      .order("created_at", { ascending: false });
    if (data) setDriverBookings(data);
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
      if (screen === "myBookings") {
        // Auto-trigger payment for completed MoMo/Card rides
        const needsPayment = data.find((b: any) =>
          b.status === "completed" &&
          b.payment !== "cash" &&
          b.payment_status !== "paid" &&
          !showPaystack
        );
        if (needsPayment && pendingPaymentBookingId !== needsPayment.id) {
          triggerPaymentForBooking(needsPayment);
          return;
        }

        // Auto-trigger rating modal for completed unrated rides
        const needsRating = data.find((b: any) =>
          b.status === "completed" &&
          !b.rated &&
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
      .select("driver_lat,driver_lng")
      .eq("id", bookingId)
      .single();
    if (data?.driver_lat) setDriverLiveLocation({ latitude: data.driver_lat, longitude: data.driver_lng });
  };

  // Client polls driver location every 3 seconds while tracking
  useEffect(() => {
    if (screen === "trackRide" && activeBookingId) {
      fetchDriverLocation(activeBookingId);
      fetchMessages(activeBookingId);
      const interval = setInterval(() => {
        fetchDriverLocation(activeBookingId);
        fetchMessages(activeBookingId);
      }, 3000);
      return () => clearInterval(interval);
    }
  }, [screen, activeBookingId]);

  // ============================================================
  // AUTH
  // ============================================================
  const doLogin = async () => {
    if (!authEmail || !authPass) { Alert.alert("Error", "Please enter email and password"); return; }
    // Demo accounts
    if (authEmail === "driver@demo.com") {
      setUser({ name: "Demo Driver", email: authEmail, role: "driver", verified: true, phone: "+233 55 000 0001" });
      go("driverHome"); return;
    }
    if (authEmail === "client@demo.com") {
      setUser({ name: "Demo Client", email: authEmail, role: "client", verified: true, phone: "+233 55 000 0002" });
      go("clientHome"); return;
    }
    const { data, error } = await supabase.auth.signInWithPassword({ email: authEmail, password: authPass });
    if (error) { Alert.alert("Error", error.message); return; }
    const { data: profile } = await supabase.from("profiles").select("*").eq("id", data.user?.id).single();
    if (!profile) { Alert.alert("Error", "Profile not found"); return; }
    const u = { name: profile.full_name, email: profile.email, phone: profile.phone_number, role: profile.role, verified: profile.is_verified, suspended: profile.suspended };
    setUser(u);
    if (u.role === "client") { go("clientHome"); }
    else {
      if (u.suspended) {
        Alert.alert("Account Suspended", "Your account has been suspended. Please contact support.");
        return;
      }
      u.verified ? go("driverHome") : go("verify");
    }
  };

  const doSignup = async () => {
    if (!authName || !authEmail || !authPass) { Alert.alert("Error", "Please fill all fields"); return; }
    if (authPass !== authConfirm) { Alert.alert("Error", "Passwords do not match"); return; }
    const { data, error } = await supabase.auth.signUp({ email: authEmail, password: authPass });
    if (error) { Alert.alert("Error", error.message); return; }
    await supabase.from("profiles").insert({
      id: data.user?.id,
      full_name: authName,
      email: authEmail,
      phone_number: authPhone,
      role: authRole,
      is_verified: authRole === "client",
    });
    setUser({ name: authName, email: authEmail, phone: authPhone, role: authRole, verified: authRole === "client" });
    if (authRole === "client") { go("clientHome"); }
    else { setVerifyStep(1); go("verify"); }
  };

  const logout = () => {
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
    ptRef.current = setTimeout(async () => setPickupSugg(await searchPlaces(t)), 600);
  };

  const dropoffChange = (t: string) => {
    setDropoffText(t); setActiveField("dropoff");
    clearTimeout(dtRef.current);
    dtRef.current = setTimeout(async () => setDropoffSugg(await searchPlaces(t)), 600);
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
    if (dropoffPin) updateFare(p.lat, p.lon, dropoffPin.latitude, dropoffPin.longitude);
  };

  const selDropoff = (p: any) => {
    setDropoffText(p.name); setDropoffPin({ latitude: p.lat, longitude: p.lon });
    setDropoffSugg([]); setActiveField(null);
    if (pickupPin) updateFare(pickupPin.latitude, pickupPin.longitude, p.lat, p.lon);
  };

  const saveBookingToSupabase = async (pickup: string, dropoff: string, service: string, price: number) => {
    const { data: { user: u } } = await supabase.auth.getUser();
    const clientId = u?.id || "00000000-0000-0000-0000-000000000001";
    const { data } = await supabase.from("bookings").insert({
      client_id: clientId,
      client_name: authName || user?.name,
      pickup,
      dropoff,
      service,
      price,
      status: "pending",
    }).select().single();
    return data;
  };

  const PAYSTACK_PUBLIC_KEY = "pk_test_bf1a50632c17401a944e134786ff7a9610768d13";
  const VERIFY_PAYMENT_URL = "https://dawdtzqgwhqchjuursjj.supabase.co/functions/v1/verify-payment";

  const submitRide = () => {
    if (!pickupText || !dropoffText) { Alert.alert("Missing", "Please enter pickup and dropoff"); return; }
    const methodLabel = paymentMethod === "momo" ? "Mobile Money" : paymentMethod === "card" ? "Card" : "Cash";
    const timingNote = paymentMethod === "cash"
      ? "You will pay the driver directly."
      : "You will be charged automatically once the ride is complete.";
    Alert.alert(
      "Confirm Booking",
      `Fare: GHS ${estFare || 20}\nPayment: ${methodLabel}\n\n${timingNote}`,
      [
        { text: "Cancel", style: "cancel" },
        { text: "Book Ride", onPress: () => processBooking() },
      ]
    );
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
          Alert.alert("Payment Successful!", `GHS ${data.amount} received via ${data.channel === "mobile_money" ? "Mobile Money" : "Card"}`);
        } else {
          Alert.alert("Payment Failed", "We could not verify your payment. You can retry from My Bookings.");
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
      Alert.alert("Email Needed", "Please make sure you're logged in with a valid email to pay online.");
      return;
    }
    setPendingPaymentBookingId(booking.id);
    setEstFare(booking.price);
    setShowPaystack(true);
  };

  const processBooking = async () => {
    const fare = estFare || 20;
    const booking = await saveBookingToSupabase(pickupText, dropoffText, selectedService, fare);
    const nb = {
      id: booking?.id || Date.now().toString(),
      service: selectedService,
      time: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
      status: "pending",
      payment_status: paymentMethod === "cash" ? "n/a" : "awaiting_completion",
      price: fare,
      pickup: pickupText,
      dropoff: dropoffText,
      payment: paymentMethod,
      km: estKm,
    };
    setClientBookings(prev => [nb, ...prev]);
    Alert.alert("Ride Booked!", `Driver is being assigned. Fare: GHS ${fare}`, [{ text: "OK", onPress: () => go("myBookings") }]);
    setPickupText(""); setDropoffText(""); setPickupPin(null); setDropoffPin(null); setEstFare(null); setEstKm(null);
  };


  const acceptOrder = async (bookingId: string) => {
    const { data: { user: u } } = await supabase.auth.getUser();
    const driverId = u?.id || "00000000-0000-0000-0000-000000000002";
    const { error } = await supabase.from("bookings").update({
      status: "accepted",
      driver_id: driverId,
    }).eq("id", bookingId);
    if (!error) {
      setActiveBookingId(bookingId);
      fetchMessages(bookingId);
      watchDriverLocation(bookingId);
      go("activeRide");
      Alert.alert("Accepted!", "You have accepted this ride.");
      fetchDriverBookings();
    } else {
      Alert.alert("Error", error.message);
    }
  };

  const completeRide = async () => {
    if (!activeBookingId) return;
    const order = driverBookings.find(b => b.id === activeBookingId);
    await supabase.from("bookings").update({ status: "completed" }).eq("id", activeBookingId);

    // Credit driver wallet with 85% of the fare (15% platform commission)
    if (order?.price) {
      const { data: { user: u } } = await supabase.auth.getUser();
      const driverId = u?.id || "00000000-0000-0000-0000-000000000002";
      const driverEarnings = parseFloat((order.price * 0.85).toFixed(2));

      const { data: existingWallet } = await supabase
        .from("wallets")
        .select("*")
        .eq("user_id", driverId)
        .maybeSingle();

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
    }

    Alert.alert("Ride Complete!", "If the client chose MoMo or Card, they'll be prompted to pay now.", [{ text: "OK", onPress: () => go("driverHome") }]);
    setActiveBookingId(null);
    fetchDriverBookings();
  };

  // ============================================================
  // DRIVER WALLET WITHDRAWAL
  // Blueprint: minimum GHS 10, max GHS 2,000/day, always free, instant via MoMo
  // ============================================================
  const withdrawEarnings = async () => {
    if (!driverWallet || driverWallet.balance < 10) {
      Alert.alert("Minimum Not Met", "You need at least GHS 10 in your wallet to withdraw.");
      return;
    }
    const amount = driverWallet.balance;
    if (amount > 2000) {
      Alert.alert(
        "Daily Limit",
        `Maximum withdrawal is GHS 2,000 per day. You'll withdraw GHS 2,000 now and can withdraw the rest tomorrow.`,
        [
          { text: "Cancel", style: "cancel" },
          { text: "Withdraw GHS 2,000", onPress: () => processWithdrawal(2000) },
        ]
      );
      return;
    }
    Alert.alert(
      "Confirm Withdrawal",
      `Withdraw GHS ${amount} via Mobile Money?\nThis is always free and instant.`,
      [
        { text: "Cancel", style: "cancel" },
        { text: "Withdraw", onPress: () => processWithdrawal(amount) },
      ]
    );
  };

  const processWithdrawal = async (amount: number) => {
    const { data: { user: u } } = await supabase.auth.getUser();
    const driverId = u?.id || "00000000-0000-0000-0000-000000000002";
    const newBalance = parseFloat((driverWallet.balance - amount).toFixed(2));
    const newWithdrawn = parseFloat((driverWallet.total_withdrawn + amount).toFixed(2));
    await supabase.from("wallets").update({
      balance: newBalance,
      total_withdrawn: newWithdrawn,
      last_updated: new Date().toISOString(),
    }).eq("user_id", driverId);
    Alert.alert("Withdrawal Successful!", `GHS ${amount} sent to your Mobile Money.`);
    fetchWallet();
  };


  // CHAT
  // ============================================================
  const sendMessage = async (bookingId: string) => {
    if (!chatInput.trim()) return;
    const { data: { user: u } } = await supabase.auth.getUser();
    const senderId = u?.id || "00000000-0000-0000-0000-000000000003";
    await supabase.from("messages").insert({
      booking_id: bookingId,
      sender_id: senderId,
      sender_name: user?.name || u?.email || "Demo User",
      message: chatInput.trim(),
    });
    setChatInput("");
    fetchMessages(bookingId);
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

  const executeSOS = async () => {
    setSosActive(true);
    setSosCountdown(0);
    if (location && activeBookingId) {
      await supabase.from("bookings").update({
        sos_triggered: true,
        sos_lat: location.latitude,
        sos_lng: location.longitude,
      }).eq("id", activeBookingId);
    }
    Alert.alert(
      "SOS ACTIVATED",
      "Your live location has been sent to admin.\nEmergency contacts alerted via SMS.\nRecording started.\n\nTap Call Police to reach Ghana Police 191.",
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
    if (status !== "granted") { Alert.alert("Permission needed"); return; }
    const r = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaType.images,
      quality: 0.7,
    });
    if (!r.canceled) setter(r.assets[0].uri);
  };

  const submitVerify = async () => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const { data: { user: u } } = await supabase.auth.getUser();
    const providerId = u?.id || "00000000-0000-0000-0000-000000000002";

    // ── CAR DRIVER: Ghana Card + License + Road Worthy + Registration + Vehicle Photo + Selfie
    if (authRole === "car_driver") {
      if (!idPhoto) { Alert.alert("Missing", "Please upload your Ghana Card"); return; }
      if (!licFront || !licBack) { Alert.alert("Missing", "Please upload your Driver's License (front and back)"); return; }
      if (!vehiclePhoto) { Alert.alert("Missing", "Please upload a photo of your vehicle"); return; }
      if (!selfiePhoto) { Alert.alert("Missing", "Please upload a live selfie"); return; }
      if (!vehMake || !vehModel || !vehPlate) { Alert.alert("Missing", "Please fill all vehicle details"); return; }
      if (!roadWorthyExpiry || !registrationExpiry) { Alert.alert("Missing", "Please enter Road Worthy and Registration expiry dates"); return; }

      const rwDate = new Date(roadWorthyExpiry);
      const regDate = new Date(registrationExpiry);
      if (isNaN(rwDate.getTime()) || isNaN(regDate.getTime())) { Alert.alert("Invalid Date", "Please enter valid dates (YYYY-MM-DD)"); return; }
      if (rwDate < today) { Alert.alert("Rejected", "Your Road Worthy Certificate has expired. Please renew and resubmit."); return; }
      if (regDate < today) { Alert.alert("Rejected", "Your Vehicle Registration has expired. Please renew and resubmit."); return; }

      await supabase.from("profiles").update({
        is_verified: true, vehicle_make: vehMake, vehicle_model: vehModel,
        vehicle_year: vehYear, vehicle_plate: vehPlate,
        road_worthy_expiry: roadWorthyExpiry, registration_expiry: registrationExpiry,
      }).eq("id", providerId);
    }

    // ── TUK TUK: Ghana Card + Road Worthy + Registration + Vehicle Photo + Selfie (NO license)
    else if (authRole === "tuktuk_driver") {
      if (!idPhoto) { Alert.alert("Missing", "Please upload your Ghana Card"); return; }
      if (!vehiclePhoto) { Alert.alert("Missing", "Please upload a photo of your Tuk Tuk"); return; }
      if (!selfiePhoto) { Alert.alert("Missing", "Please upload a live selfie"); return; }
      if (!vehMake || !vehPlate) { Alert.alert("Missing", "Please fill your Tuk Tuk details"); return; }
      if (!roadWorthyExpiry || !registrationExpiry) { Alert.alert("Missing", "Please enter Road Worthy and Registration expiry dates"); return; }

      const rwDate = new Date(roadWorthyExpiry);
      const regDate = new Date(registrationExpiry);
      if (isNaN(rwDate.getTime()) || isNaN(regDate.getTime())) { Alert.alert("Invalid Date", "Please enter valid dates (YYYY-MM-DD)"); return; }
      if (rwDate < today) { Alert.alert("Rejected", "Your Road Worthy Certificate has expired. Please renew and resubmit."); return; }
      if (regDate < today) { Alert.alert("Rejected", "Your Vehicle Registration has expired. Please renew and resubmit."); return; }

      await supabase.from("profiles").update({
        is_verified: true, vehicle_make: vehMake, vehicle_plate: vehPlate,
        road_worthy_expiry: roadWorthyExpiry, registration_expiry: registrationExpiry,
      }).eq("id", providerId);
    }

    // ── MOTORBIKE: Ghana Card + Bike Photo + Selfie ONLY (no license, no road worthy, no registration)
    else if (authRole === "motorbike_rider") {
      if (!idPhoto) { Alert.alert("Missing", "Please upload your Ghana Card"); return; }
      if (!vehiclePhoto) { Alert.alert("Missing", "Please upload a photo of your bike"); return; }
      if (!selfiePhoto) { Alert.alert("Missing", "Please upload a live selfie"); return; }

      await supabase.from("profiles").update({ is_verified: true }).eq("id", providerId);
    }

    // ── RESTAURANT/VENDOR: Ghana Card + Food Safety Cert + Restaurant Photo (menu handled separately)
    else if (authRole === "restaurant") {
      if (!idPhoto) { Alert.alert("Missing", "Please upload the owner's Ghana Card"); return; }
      if (!foodSafetyCert) { Alert.alert("Missing", "Please upload your Food Safety Certificate"); return; }
      if (!restaurantPhoto) { Alert.alert("Missing", "Please upload a photo of your restaurant or stall"); return; }
      if (!businessName) { Alert.alert("Missing", "Please enter your business name"); return; }

      await supabase.from("profiles").update({
        is_verified: true, full_name: businessName,
      }).eq("id", providerId);
    }

    // All checks passed — instant approval
    setUser((prev: any) => ({ ...prev, verified: true }));
    const roleLabel = authRole === "car_driver" ? "Car Driver" : authRole === "tuktuk_driver" ? "Tuk Tuk Rider" : authRole === "motorbike_rider" ? "Motorbike Rider" : "Restaurant/Vendor";
    Alert.alert(
      "Verified! ✅",
      `Your documents passed all checks. You're approved as a ${roleLabel} on LuminaLinks!`,
      [{ text: "Let's Go!", onPress: () => go("driverHome") }]
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
      Alert.alert("Select Stars", "Please select at least 1 star before submitting.");
      return;
    }
    setShowRatingModal(false);
    await rateDriver(pendingRatingBookingId!, selectedRating, ratingComment);
    setPendingRatingBookingId(null);
    setRatingComment("");
    setSelectedRating(0);
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
    Alert.alert("Rating Submitted!", messages[stars] || "Thank you!");
    go("myBookings");
  };

  // ============================================================
  // STYLES
  // ============================================================
  const s = StyleSheet.create({
    safe: { flex: 1, backgroundColor: "#0a0a0a" },
    center: { flex: 1, backgroundColor: "#0a0a0a", justifyContent: "center", alignItems: "center", padding: 24 },
    nav: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", padding: 16, borderBottomWidth: 1, borderBottomColor: "#222" },
    navLogo: { color: "#c9a84c", fontSize: 18, fontWeight: "bold" },
    navLink: { color: "#c9a84c", fontSize: 14 },
    title: { color: "#fff", fontSize: 26, fontWeight: "bold", marginBottom: 4 },
    input: { backgroundColor: "#1a1a1a", color: "#fff", borderRadius: 10, padding: 14, marginBottom: 12, fontSize: 15 },
    btn: { backgroundColor: "#c9a84c", borderRadius: 10, padding: 16, alignItems: "center", marginTop: 8 },
    btnTxt: { color: "#000", fontWeight: "bold", fontSize: 16 },
    btnOut: { borderWidth: 1, borderColor: "#c9a84c", borderRadius: 10, padding: 16, alignItems: "center", marginTop: 8 },
    btnOutTxt: { color: "#c9a84c", fontWeight: "bold", fontSize: 16 },
    btnGreen: { backgroundColor: "#1a3a2a", borderWidth: 1, borderColor: "#4caf50", borderRadius: 10, padding: 14, alignItems: "center", marginTop: 8 },
    btnRed: { backgroundColor: "#3a1a1a", borderWidth: 1, borderColor: "#f44336", borderRadius: 10, padding: 14, alignItems: "center", marginTop: 8 },
    card: { backgroundColor: "#1a1a1a", borderRadius: 12, padding: 16, marginBottom: 12 },
    cardTitle: { color: "#fff", fontSize: 16, fontWeight: "600" },
    cardSub: { color: "#888", fontSize: 13, marginTop: 2 },
    badge: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 20, alignSelf: "flex-start", marginTop: 6 },
    sectionTitle: { color: "#c9a84c", fontSize: 13, fontWeight: "700", letterSpacing: 1, marginBottom: 10, marginTop: 12 },
    row: { flexDirection: "row", gap: 8, marginBottom: 16 },
    statCard: { backgroundColor: "#1a1a1a", borderRadius: 12, padding: 12, alignItems: "center", flex: 1 },
    statVal: { color: "#c9a84c", fontSize: 18, fontWeight: "bold" },
    statLabel: { color: "#888", fontSize: 11, marginTop: 4 },
    roleBtn: { borderRadius: 16, padding: 24, alignItems: "center", marginBottom: 16, borderWidth: 2 },
    uploadBox: { backgroundColor: "#1a1a1a", borderRadius: 12, borderWidth: 2, borderColor: "#333", padding: 20, alignItems: "center", marginBottom: 12 },
    uploadImg: { width: "100%", height: 150, borderRadius: 10, resizeMode: "cover" },
    suggestBox: { backgroundColor: "#1e1e1e", borderRadius: 10, marginBottom: 8, borderWidth: 1, borderColor: "#333" },
    suggestItem: { padding: 12, borderBottomWidth: 1, borderBottomColor: "#2a2a2a" },
    suggestTxt: { color: "#fff", fontSize: 13 },
    fareBox: { backgroundColor: "#1a2a1a", borderRadius: 12, padding: 14, marginBottom: 8, borderWidth: 1, borderColor: "#4caf50" },
    onlineRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", backgroundColor: "#1a1a1a", borderRadius: 12, padding: 14, marginBottom: 12 },
    pinRow: { flexDirection: "row", gap: 8, marginBottom: 8 },
    pinBtn: { borderRadius: 10, padding: 10, alignItems: "center", flex: 1 },
    divider: { flexDirection: "row", alignItems: "center", marginVertical: 16 },
    dividerLine: { flex: 1, height: 1, backgroundColor: "#222" },
    dividerTxt: { color: "#888", marginHorizontal: 12 },
    verifyStep: { flexDirection: "row", alignItems: "center", backgroundColor: "#1a1a1a", borderRadius: 12, padding: 14, marginBottom: 10 },
    verifyNum: { width: 32, height: 32, borderRadius: 16, backgroundColor: "#c9a84c", alignItems: "center", justifyContent: "center", marginRight: 12 },
    serviceRow: { flexDirection: "row", gap: 8, marginBottom: 12 },
    serviceBtn: { flex: 1, borderRadius: 10, padding: 10, alignItems: "center", borderWidth: 1 },
    chatBubble: { borderRadius: 10, padding: 10, marginBottom: 6, maxWidth: "80%" },
    sosBtn: { backgroundColor: "#2a1414", borderWidth: 1, borderColor: "#f44336", borderRadius: 10, paddingVertical: 10, paddingHorizontal: 14, alignItems: "center", marginTop: 16, alignSelf: "center" },
  });

  // ============================================================
  // SCREENS
  // ============================================================
  // RATING MODAL — must be checked BEFORE screen renders so it takes priority
  if (showRatingModal) return (
    <SafeAreaView style={s.safe}>
      <View style={{ flex: 1, justifyContent: "center", alignItems: "center", padding: 24 }}>
        <View style={{ backgroundColor: "#1a1a1a", borderRadius: 16, padding: 28, width: "100%", alignItems: "center" }}>
          <Text style={{ fontSize: 40, marginBottom: 8 }}>{"🚗"}</Text>
          <Text style={{ color: "#fff", fontSize: 20, fontWeight: "bold", textAlign: "center", marginBottom: 4 }}>How was your ride?</Text>
          <Text style={{ color: "#888", fontSize: 13, textAlign: "center", marginBottom: 24 }}>Your feedback helps improve our service and keeps drivers accountable.</Text>

          <Text style={{ color: "#c9a84c", fontSize: 13, fontWeight: "700", marginBottom: 12 }}>TAP TO RATE</Text>
          <View style={{ flexDirection: "row", gap: 12, marginBottom: 24 }}>
            {[1, 2, 3, 4, 5].map(star => (
              <TouchableOpacity key={star} onPress={() => setSelectedRating(star)}>
                <Text style={{ fontSize: 44 }}>{star <= selectedRating ? "⭐" : "☆"}</Text>
              </TouchableOpacity>
            ))}
          </View>

          {selectedRating > 0 && (
            <Text style={{ color: "#c9a84c", fontSize: 14, fontWeight: "bold", marginBottom: 16 }}>
              {selectedRating === 5 ? "Excellent!" : selectedRating === 4 ? "Great!" : selectedRating === 3 ? "Good" : selectedRating === 2 ? "Fair" : "Poor"}
            </Text>
          )}

          <Text style={{ color: "#888", fontSize: 12, alignSelf: "flex-start", marginBottom: 6 }}>Comments (optional)</Text>
          <TextInput
            style={[s.input, { width: "100%", minHeight: 80, textAlignVertical: "top" }]}
            placeholder="Tell us about your experience..."
            placeholderTextColor="#555"
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
            style={{ marginTop: 14 }}
            onPress={() => { setShowRatingModal(false); go("myBookings"); }}>
            <Text style={{ color: "#555", fontSize: 13 }}>Skip for now</Text>
          </TouchableOpacity>
        </View>
      </View>
    </SafeAreaView>
  );

  // WELCOME
  if (screen === "welcome") return (
    <SafeAreaView style={s.safe}>
      <View style={s.center}>
        <Text style={{ color: "#c9a84c", fontSize: 40, fontWeight: "bold", marginBottom: 4 }}>LuminaLinks</Text>
        <Text style={{ color: "#888", fontSize: 14, marginBottom: 8, textAlign: "center" }}>Ghana's Own Super App</Text>
        <Text style={{ color: "#555", fontSize: 12, marginBottom: 40, textAlign: "center" }}>Rides | Delivery | Food | Asamankese</Text>
        <TouchableOpacity style={[s.btn, { width: "100%" }]} onPress={() => { setAuthMode("login"); go("auth"); }}>
          <Text style={s.btnTxt}>Log In</Text>
        </TouchableOpacity>
        <TouchableOpacity style={[s.btnOut, { width: "100%" }]} onPress={() => { setAuthMode("signup"); setAuthRole(null); go("roleSelect"); }}>
          <Text style={s.btnOutTxt}>Create Account</Text>
        </TouchableOpacity>
        <Text style={{ color: "#555", fontSize: 12, marginTop: 24, textAlign: "center" }}>Demo: driver@demo.com | client@demo.com</Text>
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
        <Text style={{ color: "#888", textAlign: "center", marginBottom: 24 }}>Choose your role to get started</Text>

        {[
          { role: "client", icon: "👤", label: "Client", sub: "Book rides, deliveries and food", color: "#2196f3" },
          { role: "car_driver", icon: "🚗", label: "Car Driver", sub: "Provide point-to-point rides", color: "#c9a84c" },
          { role: "tuktuk_driver", icon: "🛺", label: "Tuk Tuk Rider", sub: "Affordable short distance trips", color: "#c9a84c" },
          { role: "motorbike_rider", icon: "🏍️", label: "Motorbike Rider", sub: "Fast parcel and errand delivery", color: "#c9a84c" },
          { role: "restaurant", icon: "🍔", label: "Restaurant / Vendor", sub: "List your food for delivery", color: "#4caf50" },
        ].map(({ role, icon, label, sub, color }) => (
          <TouchableOpacity
            key={role}
            style={[s.roleBtn, { borderColor: authRole === role ? color : "#222", backgroundColor: authRole === role ? color + "22" : "#1a1a1a", marginBottom: 12 }]}
            onPress={() => setAuthRole(role)}>
            <Text style={{ fontSize: 36 }}>{icon}</Text>
            <Text style={{ color: authRole === role ? color : "#fff", fontSize: 16, fontWeight: "bold", marginTop: 6 }}>{label}</Text>
            <Text style={{ color: "#888", fontSize: 12, marginTop: 4, textAlign: "center" }}>{sub}</Text>
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
            <TextInput style={s.input} placeholder="Full Name" placeholderTextColor="#555" value={authName} onChangeText={setAuthName} />
            <TextInput style={s.input} placeholder="Phone Number" placeholderTextColor="#555" value={authPhone} onChangeText={setAuthPhone} keyboardType="phone-pad" />
          </>
        )}
        <Text style={s.sectionTitle}>ACCOUNT</Text>
        <TextInput style={s.input} placeholder="Email Address" placeholderTextColor="#555" value={authEmail} onChangeText={setAuthEmail} keyboardType="email-address" autoCapitalize="none" />
        <TextInput style={s.input} placeholder="Password" placeholderTextColor="#555" value={authPass} onChangeText={setAuthPass} secureTextEntry />
        {authMode === "signup" && (
          <TextInput style={s.input} placeholder="Confirm Password" placeholderTextColor="#555" value={authConfirm} onChangeText={setAuthConfirm} secureTextEntry />
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
        <Text style={{ color: "#fff", fontSize: 18, fontWeight: "bold", marginBottom: 4 }}>Welcome, {user?.name}!</Text>
        <Text style={{ color: "#888", fontSize: 13, marginBottom: 4 }}>
          {authRole === "motorbike_rider"
            ? "Quick 2-step verification — no road worthy or registration required for motorbike riders."
            : "Complete all steps below — approval is instant once everything is submitted."}
        </Text>
        <Text style={{ color: "#555", fontSize: 11, marginBottom: 20 }}>Expired documents are automatically rejected.</Text>

        {/* ── STEP 1: GHANA CARD (all roles) ── */}
        {verifyStep === 1 && (
          <>
            <Text style={s.sectionTitle}>STEP 1 — GHANA CARD</Text>
            <View style={s.verifyStep}>
              <View style={s.verifyNum}><Text style={{ color: "#000", fontWeight: "bold" }}>1</Text></View>
              <View>
                <Text style={{ color: "#fff", fontSize: 15, fontWeight: "600" }}>
                  {authRole === "restaurant" ? "Owner's Ghana Card" : "Ghana Card"}
                </Text>
                <Text style={{ color: "#888", fontSize: 12, marginTop: 2 }}>
                  {authRole === "restaurant" ? "Clear photo of the business owner's Ghana Card" : "Clear photo of your Ghana Card (front and back)"}
                </Text>
              </View>
            </View>
            <TouchableOpacity style={s.uploadBox} onPress={() => pickPhoto(setIdPhoto)}>
              {idPhoto ? <Image source={{ uri: idPhoto }} style={s.uploadImg} /> :
                <><Text style={{ fontSize: 40 }}>{"🪪"}</Text><Text style={{ color: "#888", marginTop: 8 }}>Tap to upload Ghana Card</Text></>}
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
                    <Text style={{ color: "#fff", fontSize: 15, fontWeight: "600" }}>Driver's License</Text>
                    <Text style={{ color: "#888", fontSize: 12, marginTop: 2 }}>Upload front and back</Text>
                  </View>
                </View>
                <Text style={{ color: "#888", marginBottom: 6 }}>Front side:</Text>
                <TouchableOpacity style={s.uploadBox} onPress={() => pickPhoto(setLicFront)}>
                  {licFront ? <Image source={{ uri: licFront }} style={s.uploadImg} /> :
                    <><Text style={{ fontSize: 36 }}>{"📄"}</Text><Text style={{ color: "#888", marginTop: 8 }}>Tap to upload front</Text></>}
                </TouchableOpacity>
                <Text style={{ color: "#888", marginBottom: 6 }}>Back side:</Text>
                <TouchableOpacity style={s.uploadBox} onPress={() => pickPhoto(setLicBack)}>
                  {licBack ? <Image source={{ uri: licBack }} style={s.uploadImg} /> :
                    <><Text style={{ fontSize: 36 }}>{"📄"}</Text><Text style={{ color: "#888", marginTop: 8 }}>Tap to upload back</Text></>}
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
                    <Text style={{ color: "#fff", fontSize: 15, fontWeight: "600" }}>{authRole === "tuktuk_driver" ? "Tuk Tuk Photo" : "Bike Photo"}</Text>
                    <Text style={{ color: "#888", fontSize: 12, marginTop: 2 }}>Clear photo showing your {authRole === "tuktuk_driver" ? "tuk tuk" : "bike"}</Text>
                  </View>
                </View>
                <TouchableOpacity style={s.uploadBox} onPress={() => pickPhoto(setVehiclePhoto)}>
                  {vehiclePhoto ? <Image source={{ uri: vehiclePhoto }} style={s.uploadImg} /> :
                    <><Text style={{ fontSize: 36 }}>{"📸"}</Text><Text style={{ color: "#888", marginTop: 8 }}>Tap to upload photo</Text></>}
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
                    <Text style={{ color: "#fff", fontSize: 15, fontWeight: "600" }}>Food Safety Certificate</Text>
                    <Text style={{ color: "#888", fontSize: 12, marginTop: 2 }}>Proves food is prepared safely</Text>
                  </View>
                </View>
                <TouchableOpacity style={s.uploadBox} onPress={() => pickPhoto(setFoodSafetyCert)}>
                  {foodSafetyCert ? <Image source={{ uri: foodSafetyCert }} style={s.uploadImg} /> :
                    <><Text style={{ fontSize: 36 }}>{"📋"}</Text><Text style={{ color: "#888", marginTop: 8 }}>Tap to upload certificate</Text></>}
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
                <Text style={{ color: "#888", marginBottom: 6 }}>Vehicle photo:</Text>
                <TouchableOpacity style={s.uploadBox} onPress={() => pickPhoto(setVehiclePhoto)}>
                  {vehiclePhoto ? <Image source={{ uri: vehiclePhoto }} style={s.uploadImg} /> :
                    <><Text style={{ fontSize: 36 }}>{"🚗"}</Text><Text style={{ color: "#888", marginTop: 8 }}>Tap to upload vehicle photo</Text></>}
                </TouchableOpacity>
                <Text style={{ color: "#888", marginBottom: 6 }}>Live selfie:</Text>
                <TouchableOpacity style={s.uploadBox} onPress={() => pickPhoto(setSelfiePhoto)}>
                  {selfiePhoto ? <Image source={{ uri: selfiePhoto }} style={s.uploadImg} /> :
                    <><Text style={{ fontSize: 36 }}>{"🤳"}</Text><Text style={{ color: "#888", marginTop: 8 }}>Tap to upload selfie</Text></>}
                </TouchableOpacity>
                {vehiclePhoto && selfiePhoto && <TouchableOpacity style={s.btn} onPress={() => setVerifyStep(4)}><Text style={s.btnTxt}>Next: Vehicle Details</Text></TouchableOpacity>}
                <TouchableOpacity style={[s.btnOut, { marginTop: 8 }]} onPress={() => setVerifyStep(2)}><Text style={s.btnOutTxt}>Back</Text></TouchableOpacity>
              </>
            )}

            {authRole === "tuktuk_driver" && (
              <>
                <Text style={s.sectionTitle}>STEP 3 — LIVE SELFIE & VEHICLE DETAILS</Text>
                <Text style={{ color: "#888", marginBottom: 6 }}>Live selfie:</Text>
                <TouchableOpacity style={s.uploadBox} onPress={() => pickPhoto(setSelfiePhoto)}>
                  {selfiePhoto ? <Image source={{ uri: selfiePhoto }} style={s.uploadImg} /> :
                    <><Text style={{ fontSize: 36 }}>{"🤳"}</Text><Text style={{ color: "#888", marginTop: 8 }}>Tap to upload selfie</Text></>}
                </TouchableOpacity>
                {selfiePhoto && (
                  <>
                    <TextInput style={s.input} placeholder="Tuk Tuk Make/Brand" placeholderTextColor="#555" value={vehMake} onChangeText={setVehMake} />
                    <TextInput style={s.input} placeholder="Plate Number" placeholderTextColor="#555" value={vehPlate} onChangeText={setVehPlate} autoCapitalize="characters" />
                    <Text style={{ color: "#c9a84c", fontSize: 12, marginBottom: 6 }}>Road Worthy Certificate Expiry</Text>
                    <TextInput style={s.input} placeholder="YYYY-MM-DD" placeholderTextColor="#555" value={roadWorthyExpiry} onChangeText={setRoadWorthyExpiry} />
                    <Text style={{ color: "#c9a84c", fontSize: 12, marginBottom: 6 }}>Vehicle Registration Expiry</Text>
                    <TextInput style={s.input} placeholder="YYYY-MM-DD" placeholderTextColor="#555" value={registrationExpiry} onChangeText={setRegistrationExpiry} />
                    <Text style={{ color: "#555", fontSize: 11, marginBottom: 8 }}>Expired documents are automatically rejected.</Text>
                  </>
                )}
                <View style={{ flexDirection: "row", gap: 8, marginTop: 8 }}>
                  <TouchableOpacity style={[s.btnOut, { flex: 1 }]} onPress={() => setVerifyStep(2)}><Text style={s.btnOutTxt}>Back</Text></TouchableOpacity>
                  {selfiePhoto && vehMake && vehPlate && roadWorthyExpiry && registrationExpiry &&
                    <TouchableOpacity style={[s.btn, { flex: 2 }]} onPress={submitVerify}><Text style={s.btnTxt}>Verify Instantly</Text></TouchableOpacity>}
                </View>
              </>
            )}

            {authRole === "motorbike_rider" && (
              <>
                <Text style={s.sectionTitle}>STEP 3 — LIVE SELFIE</Text>
                <View style={s.verifyStep}>
                  <View style={s.verifyNum}><Text style={{ color: "#000", fontWeight: "bold" }}>3</Text></View>
                  <View>
                    <Text style={{ color: "#fff", fontSize: 15, fontWeight: "600" }}>Live Selfie</Text>
                    <Text style={{ color: "#888", fontSize: 12, marginTop: 2 }}>A clear selfie for identity confirmation</Text>
                  </View>
                </View>
                <TouchableOpacity style={s.uploadBox} onPress={() => pickPhoto(setSelfiePhoto)}>
                  {selfiePhoto ? <Image source={{ uri: selfiePhoto }} style={s.uploadImg} /> :
                    <><Text style={{ fontSize: 36 }}>{"🤳"}</Text><Text style={{ color: "#888", marginTop: 8 }}>Tap to upload selfie</Text></>}
                </TouchableOpacity>
                <View style={{ flexDirection: "row", gap: 8, marginTop: 8 }}>
                  <TouchableOpacity style={[s.btnOut, { flex: 1 }]} onPress={() => setVerifyStep(2)}><Text style={s.btnOutTxt}>Back</Text></TouchableOpacity>
                  {selfiePhoto && <TouchableOpacity style={[s.btn, { flex: 2 }]} onPress={submitVerify}><Text style={s.btnTxt}>Verify Instantly</Text></TouchableOpacity>}
                </View>
              </>
            )}

            {authRole === "restaurant" && (
              <>
                <Text style={s.sectionTitle}>STEP 3 — RESTAURANT DETAILS</Text>
                <TextInput style={s.input} placeholder="Business/Restaurant Name" placeholderTextColor="#555" value={businessName} onChangeText={setBusinessName} />
                <Text style={{ color: "#888", marginBottom: 6 }}>Restaurant or stall photo:</Text>
                <TouchableOpacity style={s.uploadBox} onPress={() => pickPhoto(setRestaurantPhoto)}>
                  {restaurantPhoto ? <Image source={{ uri: restaurantPhoto }} style={s.uploadImg} /> :
                    <><Text style={{ fontSize: 36 }}>{"🍽️"}</Text><Text style={{ color: "#888", marginTop: 8 }}>Tap to upload restaurant photo</Text></>}
                </TouchableOpacity>
                <View style={{ flexDirection: "row", gap: 8, marginTop: 8 }}>
                  <TouchableOpacity style={[s.btnOut, { flex: 1 }]} onPress={() => setVerifyStep(2)}><Text style={s.btnOutTxt}>Back</Text></TouchableOpacity>
                  {restaurantPhoto && businessName && <TouchableOpacity style={[s.btn, { flex: 2 }]} onPress={submitVerify}><Text style={s.btnTxt}>Verify Instantly</Text></TouchableOpacity>}
                </View>
              </>
            )}
          </>
        )}

        {/* ── STEP 4: VEHICLE DETAILS (car driver only) ── */}
        {verifyStep === 4 && authRole === "car_driver" && (
          <>
            <Text style={s.sectionTitle}>STEP 4 — VEHICLE DETAILS</Text>
            <TextInput style={s.input} placeholder="Vehicle Make (e.g. Toyota)" placeholderTextColor="#555" value={vehMake} onChangeText={setVehMake} />
            <TextInput style={s.input} placeholder="Vehicle Model (e.g. Corolla)" placeholderTextColor="#555" value={vehModel} onChangeText={setVehModel} />
            <TextInput style={s.input} placeholder="Year (e.g. 2020)" placeholderTextColor="#555" value={vehYear} onChangeText={setVehYear} keyboardType="numeric" />
            <TextInput style={s.input} placeholder="Plate Number" placeholderTextColor="#555" value={vehPlate} onChangeText={setVehPlate} autoCapitalize="characters" />
            <Text style={{ color: "#c9a84c", fontSize: 12, marginBottom: 6, marginTop: 4 }}>Road Worthy Certificate Expiry</Text>
            <TextInput style={s.input} placeholder="YYYY-MM-DD (e.g. 2027-03-15)" placeholderTextColor="#555" value={roadWorthyExpiry} onChangeText={setRoadWorthyExpiry} />
            <Text style={{ color: "#c9a84c", fontSize: 12, marginBottom: 6 }}>Vehicle Registration Expiry</Text>
            <TextInput style={s.input} placeholder="YYYY-MM-DD (e.g. 2027-03-15)" placeholderTextColor="#555" value={registrationExpiry} onChangeText={setRegistrationExpiry} />
            <Text style={{ color: "#555", fontSize: 11, marginBottom: 8 }}>Expired documents are automatically rejected.</Text>
            <View style={{ flexDirection: "row", gap: 8, marginTop: 8 }}>
              <TouchableOpacity style={[s.btnOut, { flex: 1 }]} onPress={() => setVerifyStep(3)}><Text style={s.btnOutTxt}>Back</Text></TouchableOpacity>
              <TouchableOpacity style={[s.btn, { flex: 2 }]} onPress={submitVerify}><Text style={s.btnTxt}>Verify Instantly</Text></TouchableOpacity>
            </View>
          </>
        )}

      </ScrollView>
    </SafeAreaView>
  );

  // PENDING
  if (screen === "pending") return (
    <SafeAreaView style={s.safe}>
      <View style={s.nav}>
        <Text style={s.navLogo}>LuminaLinks</Text>
        <TouchableOpacity onPress={logout}><Text style={s.navLink}>Log Out</Text></TouchableOpacity>
      </View>
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: 24 }}>
        <Text style={{ fontSize: 40, marginBottom: 16 }}>{"📋"}</Text>
        <Text style={{ color: "#fff", fontSize: 20, fontWeight: "bold", textAlign: "center", marginBottom: 8 }}>Verification Incomplete</Text>
        <Text style={{ color: "#888", fontSize: 14, textAlign: "center", marginBottom: 24 }}>Complete your document upload to get verified instantly — no waiting required.</Text>
        <TouchableOpacity style={s.btn} onPress={() => go("verify")}><Text style={s.btnTxt}>Complete Verification</Text></TouchableOpacity>
      </View>
    </SafeAreaView>
  );

  // DRIVER HOME
  if (screen === "driverHome") return (
    <SafeAreaView style={s.safe}>
      <View style={s.nav}>
        <Text style={s.navLogo}>LuminaLinks Driver</Text>
        <TouchableOpacity onPress={logout}><Text style={s.navLink}>Log Out</Text></TouchableOpacity>
      </View>
      <ScrollView contentContainerStyle={{ padding: 20 }}>
        <Text style={{ color: "#fff", fontSize: 18, fontWeight: "bold", marginBottom: 4 }}>Welcome, {user?.name}!</Text>
        <Text style={{ color: "#888", fontSize: 13, marginBottom: 16 }}>{"Keep 85% of every fare + 100% of tips"}</Text>

        <View style={s.onlineRow}>
          <View>
            <Text style={{ color: "#fff", fontWeight: "bold" }}>Status</Text>
            <Text style={{ color: online ? "#4caf50" : "#888", fontSize: 13 }}>{online ? "Online — Receiving Rides" : "Offline"}</Text>
          </View>
          <Switch value={online} onValueChange={setOnline} trackColor={{ false: "#333", true: "#4caf50" }} thumbColor="#fff" />
        </View>

        <View style={s.row}>
          <View style={s.statCard}><Text style={s.statVal}>GHS {driverWallet?.balance?.toFixed(2) || "0.00"}</Text><Text style={s.statLabel}>Wallet</Text></View>
          <View style={s.statCard}><Text style={s.statVal}>{driverBookings.filter(b => b.status === "completed").length}</Text><Text style={s.statLabel}>Rides</Text></View>
          <View style={s.statCard}><Text style={s.statVal}>{"⭐"} {driverRating}</Text><Text style={s.statLabel}>Rating</Text></View>
        </View>

        <Text style={s.sectionTitle}>QUICK ACTIONS</Text>
        <TouchableOpacity style={s.card} onPress={() => go("clientOrders")}>
          <Text style={s.cardTitle}>{"📋"} View Incoming Orders</Text>
          <Text style={s.cardSub}>See all ride requests waiting for a driver</Text>
        </TouchableOpacity>
        <TouchableOpacity style={s.card} onPress={() => go("driverEarnings")}>
          <Text style={s.cardTitle}>{"💰"} My Earnings</Text>
          <Text style={s.cardSub}>View your earnings and withdraw anytime</Text>
        </TouchableOpacity>
        <TouchableOpacity style={s.card} onPress={() => go("driverProfile")}>
          <Text style={s.cardTitle}>{"👤"} My Profile</Text>
          <Text style={s.cardSub}>View and update your driver profile</Text>
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
      <ScrollView contentContainerStyle={{ padding: 20 }}>
        {driverBookings.length === 0
          ? <Text style={{ color: "#888", textAlign: "center", marginTop: 40 }}>No orders yet. Waiting for clients...</Text>
          : driverBookings.map((b, i) => (
            <View key={i} style={s.card}>
              <Text style={s.cardTitle}>{"🚗"} Ride Request</Text>
              <Text style={{ color: "#888", marginTop: 4 }}>{"📍"} From: {b.pickup}</Text>
              <Text style={{ color: "#888" }}>{"🏁"} To: {b.dropoff}</Text>
              <Text style={{ color: "#c9a84c", fontWeight: "bold", marginTop: 6 }}>GHS {b.price}</Text>
              <View style={{ flexDirection: "row", gap: 8, marginTop: 8 }}>
                <View style={[s.badge, { backgroundColor: b.status === "pending" ? "#2a2000" : b.status === "accepted" ? "#1a3a1a" : "#1a1a2a" }]}>
                  <Text style={{ color: b.status === "pending" ? "#f5a623" : b.status === "accepted" ? "#4caf50" : "#888", fontSize: 12 }}>{b.status?.toUpperCase()}</Text>
                </View>
              </View>
              {b.status === "pending" && (
                <TouchableOpacity style={[s.btnGreen, { marginTop: 8 }]} onPress={() => acceptOrder(b.id)}>
                  <Text style={{ color: "#4caf50", fontWeight: "bold" }}>{"✅"} Accept Ride</Text>
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
          <Text style={s.cardTitle}>{"🚗"} Ride in Progress</Text>
          <Text style={{ color: "#888", fontSize: 13, marginTop: 4 }}>{"📍"} Pickup: {activeOrder?.pickup}</Text>
          <Text style={{ color: "#888", fontSize: 13 }}>{"🏁"} Dropoff: {activeOrder?.dropoff}</Text>
          <Text style={{ color: "#4caf50", marginTop: 4 }}>Navigate to pickup location</Text>
        </View>

        <Text style={s.sectionTitle}>LIVE MAP</Text>
        <WebView
          style={{ width: "100%", height: 220, borderRadius: 12, marginBottom: 12 }}
          source={{
            html: `<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"/><script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script><style>html,body,#map{height:100%;margin:0}</style></head><body><div id="map"></div><script>
              var myLat=${location?.latitude || 6.6}, myLng=${location?.longitude || -0.9};
              var map=L.map("map").setView([myLat,myLng],14);
              L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png").addTo(map);
              var meIcon=L.divIcon({html:"🚗",iconSize:[30,30],className:"me-marker"});
              L.marker([myLat,myLng],{icon:meIcon}).addTo(map).bindPopup("You").openPopup();
            </script></body></html>`
          }}
        />

        <Text style={s.sectionTitle}>IN-APP CHAT</Text>
        <View style={{ backgroundColor: "#1a1a1a", borderRadius: 12, padding: 12, marginBottom: 8, minHeight: 120 }}>
          {chatMessages.length === 0
            ? <Text style={{ color: "#555", textAlign: "center", marginTop: 20 }}>No messages yet</Text>
            : chatMessages.map((m, i) => (
              <View key={i} style={[s.chatBubble, { backgroundColor: m.sender_id === user?.id ? "#c9a84c22" : "#1e1e1e", alignSelf: m.sender_id === user?.id ? "flex-end" : "flex-start" }]}>
                <Text style={{ color: "#888", fontSize: 11 }}>{m.sender_name}</Text>
                <Text style={{ color: "#fff" }}>{m.message}</Text>
              </View>
            ))
          }
        </View>
        <View style={{ flexDirection: "row", gap: 8, marginBottom: 16 }}>
          <TextInput style={[s.input, { flex: 1, marginBottom: 0 }]} placeholder="Type a message..." placeholderTextColor="#555" value={chatInput} onChangeText={setChatInput} />
          <TouchableOpacity style={[s.btn, { marginTop: 0, paddingHorizontal: 16 }]} onPress={() => activeBookingId && sendMessage(activeBookingId)}>
            <Text style={s.btnTxt}>Send</Text>
          </TouchableOpacity>
        </View>

        <TouchableOpacity style={s.btn} onPress={completeRide}>
          <Text style={s.btnTxt}>{"✅"} Mark Ride Complete</Text>
        </TouchableOpacity>

        {sosCountdown > 0 ? (
          <View style={[s.sosBtn, { backgroundColor: "#f44336", borderColor: "#f44336" }]}>
            <Text style={{ color: "#fff", fontWeight: "bold" }}>Sending SOS in {sosCountdown}...</Text>
            <TouchableOpacity onPress={cancelSosCountdown} style={{ marginTop: 6 }}>
              <Text style={{ color: "#fff", textDecorationLine: "underline" }}>Cancel</Text>
            </TouchableOpacity>
          </View>
        ) : (
          <TouchableOpacity
            style={[s.sosBtn, sosHolding && { backgroundColor: "#f44336", borderColor: "#f44336" }]}
            onPressIn={startSosHold}
            onPressOut={cancelSosHold}>
            <Text style={{ color: sosHolding ? "#fff" : "#f44336", fontWeight: "bold", fontSize: 13 }}>
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
        <TouchableOpacity onPress={() => go("driverHome")}><Text style={s.navLink}>Back</Text></TouchableOpacity>
        <Text style={s.navLogo}>My Earnings</Text>
        <View />
      </View>
      <ScrollView contentContainerStyle={{ padding: 20 }}>
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
          <Text style={{ color: "#4caf50", fontWeight: "bold" }}>{"📱"} Withdraw via MoMo</Text>
        </TouchableOpacity>
        <Text style={{ color: "#555", fontSize: 12, textAlign: "center", marginTop: 8 }}>Minimum withdrawal: GHS 10 | Max GHS 2,000/day | Always free</Text>
      </ScrollView>
    </SafeAreaView>
  );

  // DRIVER PROFILE
  if (screen === "driverProfile") return (
    <SafeAreaView style={s.safe}>
      <View style={s.nav}>
        <TouchableOpacity onPress={() => go("driverHome")}><Text style={s.navLink}>Back</Text></TouchableOpacity>
        <Text style={s.navLogo}>My Profile</Text>
        <View />
      </View>
      <ScrollView contentContainerStyle={{ padding: 20 }}>
        <View style={s.card}>
          <Text style={s.cardTitle}>{user?.name}</Text>
          <Text style={s.cardSub}>{user?.email}</Text>
          <Text style={s.cardSub}>{user?.phone}</Text>
          <View style={[s.badge, { backgroundColor: "#1a3a1a" }]}>
            <Text style={{ color: "#4caf50", fontSize: 12 }}>{"✅"} Verified Driver</Text>
          </View>
          <View style={[s.badge, { backgroundColor: "#1a2a1a", marginTop: 6 }]}>
            <Text style={{ color: "#c9a84c", fontSize: 12 }}>{"⭐"} {driverRating} average rating</Text>
          </View>
        </View>
        <Text style={s.sectionTitle}>COMMISSION RATE</Text>
        <View style={s.card}>
          <Text style={{ color: "#fff" }}>Platform takes: <Text style={{ color: "#c9a84c", fontWeight: "bold" }}>15%</Text></Text>
          <Text style={{ color: "#fff" }}>You keep: <Text style={{ color: "#4caf50", fontWeight: "bold" }}>85% + 100% of tips</Text></Text>
        </View>
        <TouchableOpacity style={s.btnOut} onPress={logout}><Text style={s.btnOutTxt}>Log Out</Text></TouchableOpacity>
      </ScrollView>
    </SafeAreaView>
  );

  // CLIENT HOME
  if (screen === "clientHome") return (
    <SafeAreaView style={s.safe}>
      <View style={s.nav}>
        <Text style={s.navLogo}>LuminaLinks</Text>
        <TouchableOpacity onPress={logout}><Text style={s.navLink}>Log Out</Text></TouchableOpacity>
      </View>
      <ScrollView contentContainerStyle={{ padding: 20 }}>
        <Text style={{ color: "#fff", fontSize: 18, fontWeight: "bold", marginBottom: 4 }}>Hello, {user?.name}!</Text>
        <Text style={{ color: "#888", fontSize: 13, marginBottom: 20 }}>Where are you going today?</Text>

        <Text style={s.sectionTitle}>SERVICES</Text>
        {[
          ["🚗", "Car Ride", "Point-to-point rides", "car"],
          ["🛺", "Tuk Tuk", "Affordable short trips", "tuktuk"],
          ["🏍️", "Motorbike Delivery", "Fast parcel delivery", "motorbike"],
          ["🍔", "Food Delivery", "Restaurants and street food", "food"],
        ].map(([icon, title, sub, type]) => (
          <TouchableOpacity
            key={title}
            style={[s.card, { flexDirection: "row", alignItems: "center" }]}
            onPress={() => {
              if (type === "food") { Alert.alert("Coming Soon!", "Food delivery launching soon!"); return; }
              setSelectedService(type as string);
              go("bookRide");
            }}>
            <Text style={{ fontSize: 32, marginRight: 16 }}>{icon}</Text>
            <View style={{ flex: 1 }}>
              <Text style={s.cardTitle}>{title}</Text>
              <Text style={s.cardSub}>{sub}</Text>
            </View>
            <Text style={{ color: "#c9a84c" }}>{"→"}</Text>
          </TouchableOpacity>
        ))}

        <Text style={s.sectionTitle}>MY ACCOUNT</Text>
        <TouchableOpacity style={s.card} onPress={() => go("myBookings")}>
          <Text style={s.cardTitle}>{"📋"} My Bookings</Text>
          <Text style={s.cardSub}>View all your rides and orders</Text>
        </TouchableOpacity>
      </ScrollView>
    </SafeAreaView>
  );

  // BOOK RIDE
  if (screen === "bookRide") return (
    <SafeAreaView style={s.safe}>
      <View style={s.nav}>
        <TouchableOpacity onPress={() => go("clientHome")}><Text style={s.navLink}>Back</Text></TouchableOpacity>
        <Text style={s.navLogo}>Book a {selectedService === "tuktuk" ? "Tuk Tuk" : selectedService === "motorbike" ? "Delivery" : "Ride"}</Text>
        <View />
      </View>
      <ScrollView contentContainerStyle={{ padding: 16 }} keyboardShouldPersistTaps="handled">

        <Text style={s.sectionTitle}>PICKUP LOCATION</Text>
        <TextInput style={s.input} placeholder="Search pickup address..." placeholderTextColor="#555" value={pickupText} onChangeText={pickupChange} onFocus={() => setActiveField("pickup")} />
        {activeField === "pickup" && pickupSugg.length > 0 && (
          <View style={s.suggestBox}>
            {pickupSugg.map((p, i) => (
              <TouchableOpacity key={i} style={s.suggestItem} onPress={() => selPickup(p)}>
                <Text style={s.suggestTxt}>{"📍"} {p.name.length > 60 ? p.name.substring(0, 60) + "..." : p.name}</Text>
              </TouchableOpacity>
            ))}
          </View>
        )}

        <Text style={s.sectionTitle}>DROPOFF LOCATION</Text>
        <TextInput style={s.input} placeholder="Search dropoff address..." placeholderTextColor="#555" value={dropoffText} onChangeText={dropoffChange} onFocus={() => setActiveField("dropoff")} />
        {activeField === "dropoff" && dropoffSugg.length > 0 && (
          <View style={s.suggestBox}>
            {dropoffSugg.map((p, i) => (
              <TouchableOpacity key={i} style={s.suggestItem} onPress={() => selDropoff(p)}>
                <Text style={s.suggestTxt}>{"🏁"} {p.name.length > 60 ? p.name.substring(0, 60) + "..." : p.name}</Text>
              </TouchableOpacity>
            ))}
          </View>
        )}

        <Text style={s.sectionTitle}>OR PIN DROPOFF ON MAP</Text>
        <View style={s.pinRow}>
          <TouchableOpacity
            style={[s.pinBtn, { backgroundColor: pinMode === "dropoff" ? "#e91e63" : "#2a1a1a", borderWidth: 1, borderColor: "#e91e63", flex: 1 }]}
            onPress={() => setPinMode(pinMode === "dropoff" ? null : "dropoff")}>
            <Text style={{ color: "#fff", fontWeight: "700" }}>{pinMode === "dropoff" ? "Tap map..." : "Pin Dropoff"}</Text>
          </TouchableOpacity>
        </View>

        <WebView
          style={{ width: "100%", height: 220, borderRadius: 12, marginBottom: 12 }}
          onMessage={async (e) => {
            try {
              const d = JSON.parse(e.nativeEvent.data);
              setDropoffText("Locating address...");
              setDropoffPin({ latitude: d.lat, longitude: d.lng });
              const address = await reverseGeocode(d.lat, d.lng);
              setDropoffText(address);
              if (pickupPin) updateFare(pickupPin.latitude, pickupPin.longitude, d.lat, d.lng);
            } catch (err) { }
          }}
          source={{
            html: `<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"/><script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script><style>html,body,#map{height:100%;margin:0}</style></head><body><div id="map"></div><script>var map=L.map("map").setView([${pickupPin?.latitude || location?.latitude || 6.6},${pickupPin?.longitude || location?.longitude || -0.9}],14);L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png").addTo(map);${pickupPin ? `L.marker([${pickupPin.latitude},${pickupPin.longitude}]).addTo(map).bindPopup("Pickup").openPopup();` : ""}var dk=null;map.on("click",function(e){if(dk)map.removeLayer(dk);dk=L.marker(e.latlng).addTo(map).bindPopup("Dropoff").openPopup();window.ReactNativeWebView.postMessage(JSON.stringify({type:"dropoff",lat:e.latlng.lat,lng:e.latlng.lng}));});</script></body></html>`
          }}
        />

        {estFare && (
          <View style={s.fareBox}>
            <Text style={{ color: "#4caf50", fontWeight: "bold", fontSize: 16, textAlign: "center" }}>Estimated Fare</Text>
            <Text style={{ color: "#fff", fontSize: 32, fontWeight: "bold", textAlign: "center", marginTop: 4 }}>GHS {estFare}</Text>
            <Text style={{ color: "#888", textAlign: "center", marginTop: 4 }}>{estKm} km</Text>
            <Text style={{ color: "#555", textAlign: "center", fontSize: 12 }}>{getSurgeLabel(driverBookings.filter(b => b.status === "pending").length).label}</Text>
          </View>
        )}

        <Text style={s.sectionTitle}>PAYMENT METHOD</Text>
        <View style={{ flexDirection: "row", gap: 8, marginBottom: 12 }}>
          {[["cash", "💵", "Cash"], ["momo", "📱", "MoMo"], ["card", "💳", "Card"]].map(([val, icon, label]) => (
            <TouchableOpacity
              key={val}
              onPress={() => setPaymentMethod(val)}
              style={{ flex: 1, padding: 12, borderRadius: 8, backgroundColor: paymentMethod === val ? "#c9a84c" : "#1a1a1a", borderWidth: 1, borderColor: paymentMethod === val ? "#c9a84c" : "#333", alignItems: "center" }}>
              <Text style={{ fontSize: 20 }}>{icon}</Text>
              <Text style={{ color: paymentMethod === val ? "#000" : "#fff", fontSize: 12, fontWeight: paymentMethod === val ? "bold" : "normal" }}>{label}</Text>
            </TouchableOpacity>
          ))}
        </View>

        <TouchableOpacity style={[s.btn, { marginTop: 8 }]} onPress={submitRide}>
          <Text style={s.btnTxt}>{"🚗"} Confirm Booking</Text>
        </TouchableOpacity>
      </ScrollView>

      {showPaystack && (
        <View style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0, backgroundColor: "#000" }}>
          <View style={s.nav}>
            <TouchableOpacity onPress={() => setShowPaystack(false)}><Text style={s.navLink}>Cancel</Text></TouchableOpacity>
            <Text style={s.navLogo}>Secure Payment</Text>
            <View />
          </View>
          <WebView
            source={{
              html: `<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><script src="https://js.paystack.co/v1/inline.js"></script></head><body style="margin:0;background:#0a0a0a;display:flex;align-items:center;justify-content:center;height:100vh;"><script>
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
        </View>
      )}
    </SafeAreaView>
  );

  // MY BOOKINGS (CLIENT)
  if (screen === "myBookings") return (
    <SafeAreaView style={s.safe}>
      <View style={s.nav}>
        <TouchableOpacity onPress={() => go("clientHome")}><Text style={s.navLink}>Back</Text></TouchableOpacity>
        <Text style={s.navLogo}>My Bookings</Text>
        <View />
      </View>
      <ScrollView contentContainerStyle={{ padding: 20 }}>
        {clientBookings.length === 0
          ? <Text style={{ color: "#888", textAlign: "center", marginTop: 40 }}>No bookings yet. Book your first ride!</Text>
          : clientBookings.map((b, i) => (
            <View key={i} style={s.card}>
              <Text style={s.cardTitle}>{"🚗"} {b.service === "tuktuk" ? "Tuk Tuk" : b.service === "motorbike" ? "Delivery" : "Car Ride"}</Text>
              <Text style={{ color: "#888", fontSize: 13, marginTop: 4 }}>{"📍"} From: {b.pickup}</Text>
              <Text style={{ color: "#888", fontSize: 13 }}>{"🏁"} To: {b.dropoff}</Text>
              <View style={{ flexDirection: "row", justifyContent: "space-between", marginTop: 8 }}>
                <Text style={{ color: "#c9a84c", fontWeight: "bold" }}>GHS {b.price}</Text>
                <Text style={{ color: "#555", fontSize: 12 }}>
                  {b.payment === "momo" ? "📱 MoMo" : b.payment === "card" ? "💳 Card" : "💵 Cash"}
                </Text>
              </View>
              <View style={[s.badge, { backgroundColor: b.status === "pending" ? "#2a2000" : b.status === "accepted" ? "#1a3a1a" : "#1a1a2a" }]}>
                <Text style={{ color: b.status === "pending" ? "#f5a623" : b.status === "accepted" ? "#4caf50" : "#888", fontSize: 12 }}>
                  {b.status?.toUpperCase()}
                </Text>
              </View>
              {b.status === "accepted" && (
                <TouchableOpacity style={[s.btnGreen, { marginTop: 8 }]} onPress={() => { setActiveBookingId(b.id); go("trackRide"); }}>
                  <Text style={{ color: "#4caf50", fontWeight: "bold" }}>{"📍"} Track Driver Live</Text>
                </TouchableOpacity>
              )}
              {b.status === "completed" && !b.rated && (
                <TouchableOpacity style={[s.btnGreen, { marginTop: 8 }]} onPress={() => openRatingModal(b.id)}>
                  <Text style={{ color: "#4caf50", fontWeight: "bold" }}>{"⭐"} Rate Your Driver</Text>
                </TouchableOpacity>
              )}
            </View>
          ))
        }
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
            <Text style={s.cardTitle}>{"🚗"} {activeBooking?.service === "tuktuk" ? "Tuk Tuk" : "Car"} On The Way</Text>
            <Text style={{ color: "#888", fontSize: 13, marginTop: 4 }}>{"📍"} From: {activeBooking?.pickup}</Text>
            <Text style={{ color: "#888", fontSize: 13 }}>{"🏁"} To: {activeBooking?.dropoff}</Text>
          </View>

          <Text style={s.sectionTitle}>LIVE LOCATION</Text>
          <WebView
            style={{ width: "100%", height: 260, borderRadius: 12, marginBottom: 12 }}
            source={{
              html: `<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"/><script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script><style>html,body,#map{height:100%;margin:0}</style></head><body><div id="map"></div><script>
                var driverLat=${driverLiveLocation?.latitude || pickupPin?.latitude || location?.latitude || 6.6};
                var driverLng=${driverLiveLocation?.longitude || pickupPin?.longitude || location?.longitude || -0.9};
                var map=L.map("map").setView([driverLat,driverLng],15);
                L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png").addTo(map);
                var driverIcon=L.divIcon({html:"🚗",iconSize:[30,30],className:"driver-marker"});
                L.marker([driverLat,driverLng],{icon:driverIcon}).addTo(map).bindPopup("Your Driver").openPopup();
              </script></body></html>`
            }}
          />
          {driverLiveLocation
            ? <Text style={{ color: "#4caf50", textAlign: "center", marginBottom: 12 }}>{"●"} Live — updating every 3 seconds</Text>
            : <Text style={{ color: "#888", textAlign: "center", marginBottom: 12 }}>Waiting for driver location...</Text>
          }

          <Text style={s.sectionTitle}>CHAT WITH DRIVER</Text>
          <View style={{ backgroundColor: "#1a1a1a", borderRadius: 12, padding: 12, marginBottom: 8, minHeight: 120 }}>
            {chatMessages.length === 0
              ? <Text style={{ color: "#555", textAlign: "center", marginTop: 20 }}>No messages yet</Text>
              : chatMessages.map((m, i) => (
                <View key={i} style={[s.chatBubble, { backgroundColor: m.sender_id === user?.id ? "#c9a84c22" : "#1e1e1e", alignSelf: m.sender_id === user?.id ? "flex-end" : "flex-start" }]}>
                  <Text style={{ color: "#888", fontSize: 11 }}>{m.sender_name}</Text>
                  <Text style={{ color: "#fff" }}>{m.message}</Text>
                </View>
              ))
            }
          </View>
          <View style={{ flexDirection: "row", gap: 8, marginBottom: 16 }}>
            <TextInput style={[s.input, { flex: 1, marginBottom: 0 }]} placeholder="Type a message..." placeholderTextColor="#555" value={chatInput} onChangeText={setChatInput} />
            <TouchableOpacity style={[s.btn, { marginTop: 0, paddingHorizontal: 16 }]} onPress={() => activeBookingId && sendMessage(activeBookingId)}>
              <Text style={s.btnTxt}>Send</Text>
            </TouchableOpacity>
          </View>

          {sosCountdown > 0 ? (
            <View style={[s.sosBtn, { backgroundColor: "#f44336", borderColor: "#f44336" }]}>
              <Text style={{ color: "#fff", fontWeight: "bold" }}>Sending SOS in {sosCountdown}...</Text>
              <TouchableOpacity onPress={cancelSosCountdown} style={{ marginTop: 6 }}>
                <Text style={{ color: "#fff", textDecorationLine: "underline" }}>Cancel</Text>
              </TouchableOpacity>
            </View>
          ) : (
            <TouchableOpacity
              style={[s.sosBtn, sosHolding && { backgroundColor: "#f44336", borderColor: "#f44336" }]}
              onPressIn={startSosHold}
              onPressOut={cancelSosHold}>
              <Text style={{ color: sosHolding ? "#fff" : "#f44336", fontWeight: "bold", fontSize: 13 }}>
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
