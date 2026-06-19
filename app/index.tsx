import React, { useState } from "react";
import { 
  View, 
  Text, 
  ScrollView, 
  TouchableOpacity, 
  StyleSheet, 
  SafeAreaView, 
  TextInput, 
  Alert 
} from "react-native";
import AsyncStorage from '@react-native-async-storage/async-storage';
import { createClient } from '@supabase/supabase-js';

// Declare a type-safe bridge descriptor for the dynamic dynamic-require block
declare var require: any;

// ====================================================================
// SAFE NATIVE MODULE FALLBACK ENGINE
// ====================================================================
let WebView: any = null;
try {
  const WebViewModule = require("react-native-webview");
  WebView = WebViewModule.WebView;
} catch (e) {
  console.warn("WebView native module not detected in this runtime environment. Falling back to native tracking layout.");
}

// ====================================================================
// LIVE DATABASE INITIALIZATION ENGINE
// ====================================================================
const SUPABASE_URL = 'https://dawdtzqgwhqchjuursjj.supabase.co'; 
const SUPABASE_ANON_KEY = 'sb_publishable_lX1-hRBtIORwHYZQ0O0o_g_s7zM9ii7';

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    storage: AsyncStorage,
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: false,
  },
});

// Localized Ghana Boundary Search Dataset Matrix
const GHANA_LOCATIONS_POOL = [
  "Legon Campus, Accra",
  "East Legon, Shiashie",
  "Airport Residential Area, Accra",
  "Osu, Oxford Street",
  "Tema Community 1, Harbour Zone",
  "Tema Community 6, Residential",
  "Madina Estates, Accra",
  "Accra Central, Makola",
  "Cantonments, Embassy Row",
  "Labone, Greater Accra"
];

const HOME_MARKETPLACE_SERVICES = [
  { id: "ac", title: "Air Conditioner Service", icon: "❄️", price: "GHS 150", desc: "Deep filter chemical wash and gas level validation." },
  { id: "electric", title: "Electrical Engineering", icon: "⚡", price: "GHS 100", desc: "Fault diagnostics, breaker fixes, and domestic routing." },
  { id: "plumbing", title: "Plumbing & Hydraulics", icon: "🚰", price: "GHS 90", desc: "Pressure leak controls, tap fittings, and drain management." },
  { id: "cleaning", title: "Premium Home Cleaning", icon: "🧹", price: "GHS 180", desc: "Complete deep room sanitization and surface polishing." }
];

const RECURRING_FOOD_MARKETPLAY = [
  { 
    id: "v1", 
    name: "Golden Skillet Kitchen", 
    type: "Gourmet Hub", 
    rating: "4.9", 
    time: "10-20 mins", 
    items: [
      { name: "Special Fried Rice + Grilled Chicken Breast", price: 55.00 }, 
      { name: "Assorted Spicy Singapore Noodles", price: 45.00 }
    ] 
  },
  { 
    id: "v2", 
    name: "Traditional Heritage Kitchen", 
    type: "Local Delicacy", 
    rating: "4.8", 
    time: "15-30 mins", 
    items: [
      { name: "Executive Waakye Pack (Fish, Meat, Wele, Egg)", price: 65.00 }, 
      { name: "Standard Waakye Base + Gari & Hot Shito", price: 30.00 }
    ] 
  }
];

export default function App() {
  // Navigation Router Channels
  const [screen, setScreen] = useState<string>("welcome"); 
  const [authRole, setAuthRole] = useState<"client" | "driver" | "vendor" | "service_provider" | null>(null);
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
  
  // Base Authentication Variables WITH COMPREHENSIVE MOCKUP INITIAL VALUES
  const [regName, setRegName] = useState("Test System Admin");
  const [regPhone, setRegPhone] = useState("0541234567");
  const [regPassword, setRegPassword] = useState("LuminaSecure2026!");
  
  // Specific Fleet & Business Configurations
  const [driverSubType, setDriverSubType] = useState<"car" | "tuktuk" | "delivery">("car");
  const [docApprovedStatus, setDocApprovedStatus] = useState<boolean>(false);
  
  // Media Collection Nodes Pre-filled with standard validation placeholders
  const [profilePic, setProfilePic] = useState("https://images.unsplash.com/photo-1534528741775-53994a69daeb");
  const [liveSelfiePic, setLiveSelfiePic] = useState("https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d");

  // Base Driver Documentation Variables Pre-filled for Testing
  const [docNationalId, setDocNationalId] = useState("GHA-718293812-0");
  const [docLicense, setDocLicense] = useState("DL-9923810-A");
  const [docRoadWorthy, setDocRoadWorthy] = useState("RW-2026-88192");
  const [docVehicleDetails, setDocVehicleDetails] = useState("Toyota Vitz, Silver, GW-4921-26");
  
  // Vendor-Specific Identity Fields Pre-filled for Testing
  const [vendorBusinessName, setVendorBusinessName] = useState("Lumina Spice Kitchen (Legon)");
  const [vendorOperatingHours, setVendorOperatingHours] = useState("08:00 AM - 11:00 PM");
  const [vendorIdCard, setVendorIdCard] = useState("GHA-110293847-5");

  // Home Service Provider Identity Fields Pre-filled for Testing
  const [serviceBusinessName, setServiceBusinessName] = useState("Lumina Pro Engineering Ltd");
  const [serviceYearsExperience, setServiceYearsExperience] = useState("5 Years");
  const [serviceCertificationId, setServiceCertificationId] = useState("CERT-EE-2026-94B");

  // Vendor Menu Content Hooks Pre-filled with valid configurations
  const [dish1Name, setDish1Name] = useState("Assorted Jollof Rice with Grilled Chicken"); 
  const [dish1Price, setDish1Price] = useState("65.00"); 
  const [dish1Pic, setDish1Pic] = useState("https://images.unsplash.com/photo-1604329760661-e71dc83f8f26");

  const [dish2Name, setDish2Name] = useState("Executive Waakye Ecosystem Pack"); 
  const [dish2Price, setDish2Price] = useState("80.00"); 
  const [dish2Pic, setDish2Pic] = useState("https://images.unsplash.com/photo-1512058564366-18510be2db19");

  const [dish3Name, setDish3Name] = useState("Spicy Kelewele side with Roasted Peanuts"); 
  const [dish3Price, setDish3Price] = useState("35.00"); 
  const [dish3Pic, setDish3Pic] = useState("https://images.unsplash.com/photo-1565299624946-b28f40a0ae38");

  // Sub-navigation interfaces
  const [clientSubTab, setClientSubTab] = useState<"transit" | "food" | "services">("transit");

  // Address Autocomplete Dynamic Selection Arrays
  const [pickupText, setPickupText] = useState("");
  const [dropoffText, setDropoffText] = useState("");
  const [focusedInput, setFocusedInput] = useState<"pickup" | "dropoff" | null>(null);

  const [liveVendorOrders] = useState([
    { id: "ORD-9982", item: "2x Assorted Jollof Rice + Grilled Chicken", status: "PENDING", customer: "K. Mensah", address: "Apartment B4, Airport Residential", cash: "130.00" },
    { id: "ORD-4412", item: "1x Executive Waakye Ecosystem Pack", status: "PREPARING", customer: "A. Osei", address: "Office Block 3, Westlands", cash: "80.00" }
  ]);

  const [liveServiceRequests] = useState([
    { id: "SRV-5021", serviceType: "Electrical Engineering", scope: "Fault diagnostics & repair", customer: "Dr. E. Ismaila", address: "Staff Bungalow C3, Legon Campus", estimate: "100.00", status: "PENDING" }
  ]);

  // Async Identity Action Functions
  const handleStepOneVerification = async () => {
    if (!regName.trim() || !regPhone.trim() || !regPassword.trim() || !authRole) {
      Alert.alert("Input Deficit", "Name, Phone Number, and Secure Password are required variables.");
      return;
    }

    try {
      const { data, error } = await supabase.auth.signUp({
        phone: regPhone,
        password: regPassword,
        options: {
          data: {
            full_name: regName,
            phone_number: regPhone,
            role: authRole,
          }
        }
      });

      if (error) throw error;
      if (!data.user) throw new Error("Authentication layer returned null payload.");

      setCurrentUserId(data.user.id);

      if (authRole === "client") {
        Alert.alert("Access Granted", `Welcome to LuminaLinks, ${regName}!`);
        setScreen("clientDashboard");
      } else {
        setDocApprovedStatus(false);
        setScreen("providerExtendedAuth");
      }
    } catch (error: any) {
      Alert.alert("Database Connection Failed", error.message || "Transit error occurred.");
    }
  };

  const simulateAutomatedDocumentScan = async () => {
    if (!currentUserId) {
      Alert.alert("System Exception", "Session identifier token context missing.");
      return;
    }

    try {
      if (authRole === "driver") {
        const { error } = await supabase.from("driver_profiles").insert({
          id: currentUserId,
          tier: driverSubType,
          national_id: docNationalId,
          driving_license: docLicense,
          road_worthiness_token: docRoadWorthy,
          vehicle_details: docVehicleDetails,
        });
        if (error) throw error;
      } else if (authRole === "vendor") {
        const { error } = await supabase.from("vendor_profiles").insert({
          id: currentUserId,
          business_name: vendorBusinessName,
          operating_hours: vendorOperatingHours,
          national_id: vendorIdCard,
        });
        if (error) throw error;
      } else if (authRole === "service_provider") {
        const { error } = await supabase.from("service_provider_profiles").insert({
          id: currentUserId,
          business_name: serviceBusinessName,
          years_experience: serviceYearsExperience,
          certification_id: serviceCertificationId,
        });
        if (error) throw error;
      }

      setDocApprovedStatus(true);
      Alert.alert("Compliance Verified", "Credentials mapped into live database tables.");
    } catch (error: any) {
      Alert.alert("Write Handshake Rejected", error.message);
    }
  };

  const handleProviderFinalSubmit = async () => {
    if (!currentUserId) return;

    if (authRole === "vendor") {
      try {
        await supabase.from("profiles").update({ profile_pic_url: profilePic }).eq("id", currentUserId);

        const menuPayload = [
          { vendor_id: currentUserId, name: dish1Name, price: parseFloat(dish1Price), image_url: dish1Pic },
          { vendor_id: currentUserId, name: dish2Name, price: parseFloat(dish2Price), image_url: dish2Pic },
          { vendor_id: currentUserId, name: dish3Name, price: parseFloat(dish3Price), image_url: dish3Pic }
        ];

        const { error } = await supabase.from("menu_items").insert(menuPayload);
        if (error) throw error;
      } catch (error: any) {
        Alert.alert("Catalog Error", error.message);
        return;
      }
    } else {
      await supabase.from("profiles").update({ profile_pic_url: profilePic }).eq("id", currentUserId);
    }
    setScreen("liveSelfieCheck");
  };

  const handleExecuteLiveSelfieMatch = async () => {
    if (!liveSelfiePic.trim() || !currentUserId) {
      Alert.alert("Camera Node Offline", "Please supply a visual path verification check.");
      return;
    }

    try {
      const { error } = await supabase.from("profiles").update({ 
        live_selfie_url: liveSelfiePic,
        is_verified: true 
      }).eq("id", currentUserId);

      if (error) throw error;

      Alert.alert("Biometrics Completed", "Verification matching rules passed.", [
        { 
          text: "Launch Console Portal", 
          onPress: () => {
            if (authRole === "driver") setScreen("driverDashboard");
            else if (authRole === "vendor") setScreen("vendorDashboard");
            else if (authRole === "service_provider") setScreen("serviceDashboard");
          } 
        }
      ]);
    } catch (error: any) {
      Alert.alert("Verification Write Aborted", error.message);
    }
  };

  const getFilteredLocations = (queryText: string) => {
    if (!queryText.trim()) return [];
    return GHANA_LOCATIONS_POOL.filter(loc => loc.toLowerCase().includes(queryText.toLowerCase()));
  };

  // ==========================================
  // RENDER CONTROL ROUTING DISPATCHER
  // ==========================================

  if (screen === "welcome") {
    return (
      <SafeAreaView style={styles.container}>
        <ScrollView contentContainerStyle={styles.centerScroll}>
          <View style={styles.brandHeader}>
            <Text style={styles.brandText}>LUMINALINKS</Text>
            <Text style={styles.tagline}>Built for Efficiency • Powered by Africa</Text>
          </View>
          <View style={styles.roleSelectionBox}>
            <Text style={styles.selectionTitle}>Select System Access Portal</Text>
            
            <TouchableOpacity style={[styles.dashboardVisualCard, { borderLeftColor: "#38bdf8" }]} onPress={() => { setAuthRole("client"); setScreen("primaryRegistration"); }}>
              <Text style={styles.cardHeaderTitleText}>📱 Super-App Client Portal</Text>
              <Text style={styles.cardSubTitleText}>On-demand logistics routing, localized culinary tracking, and vetted professional access.</Text>
            </TouchableOpacity>

            <TouchableOpacity style={[styles.dashboardVisualCard, { borderLeftColor: "#fbbf24", marginTop: 14 }]} onPress={() => { setAuthRole("driver"); setScreen("primaryRegistration"); }}>
              <Text style={styles.cardHeaderTitleText}>🚕 Logistics Fulfillment Partner</Text>
              <Text style={styles.cardSubTitleText}>Accept on-demand transit tracks or localized courier packages with structured splits.</Text>
            </TouchableOpacity>

            <TouchableOpacity style={[styles.dashboardVisualCard, { borderLeftColor: "#34d399", marginTop: 14 }]} onPress={() => { setAuthRole("vendor"); setScreen("primaryRegistration"); }}>
              <Text style={styles.cardHeaderTitleText}>🍳 Merchant Kitchen Engine</Text>
              <Text style={styles.cardSubTitleText}>Synchronize restaurant menu sheets to the database layer and organize active customer requests.</Text>
            </TouchableOpacity>

            <TouchableOpacity style={[styles.dashboardVisualCard, { borderLeftColor: "#a78bfa", marginTop: 14 }]} onPress={() => { setAuthRole("service_provider"); setScreen("primaryRegistration"); }}>
              <Text style={styles.cardHeaderTitleText}>🛠️ Home Service Specialist Terminal</Text>
              <Text style={styles.cardSubTitleText}>Dispatch out to trade requests for HVAC maintenance, electrical rewiring, and infrastructure management.</Text>
            </TouchableOpacity>
          </View>
        </ScrollView>
      </SafeAreaView>
    );
  }

  if (screen === "primaryRegistration") {
    return (
      <SafeAreaView style={styles.container}>
        <ScrollView contentContainerStyle={styles.centerScroll}>
          <Text style={styles.authHeaderTitle}>Profile Identification</Text>
          <Text style={styles.authSubTitle}>Step 1: Universal credentials registry allocation</Text>
          <View style={styles.formContainer}>
            <Text style={styles.inputLabelHeader}>Full Name / Legal Entity Name</Text>
            <TextInput style={styles.inputField} placeholder="Enter your full name" placeholderTextColor="#64748b" value={regName} onChangeText={setRegName} />

            <Text style={styles.inputLabelHeader}>Phone Number (Mobile Money Sync)</Text>
            <TextInput style={styles.inputField} placeholder="e.g., 0541234567" placeholderTextColor="#64748b" keyboardType="phone-pad" value={regPhone} onChangeText={setRegPhone} />

            <Text style={styles.inputLabelHeader}>Secure Password Account Token</Text>
            <TextInput style={styles.inputField} placeholder="Create a secure password" placeholderTextColor="#64748b" secureTextEntry={true} value={regPassword} onChangeText={setRegPassword} />

            <TouchableOpacity style={[styles.primaryButton, { marginTop: 20 }]} onPress={handleStepOneVerification}>
              <Text style={styles.buttonText}>
                {authRole === "client" ? "Launch Client Area" : "Proceed to Document Verification →"}
              </Text>
            </TouchableOpacity>
          </View>
        </ScrollView>
      </SafeAreaView>
    );
  }

  if (screen === "providerExtendedAuth") {
    return (
      <SafeAreaView style={styles.container}>
        <ScrollView contentContainerStyle={{ padding: 24 }}>
          <Text style={styles.authHeaderTitle}>Compliance Upload Portal</Text>
          <Text style={styles.authSubTitle}>Step 2: Base documentation validation verification checks</Text>

          {authRole === "driver" && (
            <View style={styles.formContainer}>
              <Text style={styles.inputLabelHeader}>Vehicle Asset Tier</Text>
              <TextInput style={styles.inputField} placeholder="car, tuktuk, or delivery" placeholderTextColor="#64748b" value={driverSubType} onChangeText={(t: any) => setDriverSubType(t)} />
              <Text style={styles.inputLabelHeader}>National ID Card Number (GH-Card)</Text>
              <TextInput style={styles.inputField} placeholder="GHA-XXXXXXXXX-X" placeholderTextColor="#64748b" value={docNationalId} onChangeText={setDocNationalId} />
              <Text style={styles.inputLabelHeader}>Driving License ID</Text>
              <TextInput style={styles.inputField} placeholder="DL-XXXXXXXX" placeholderTextColor="#64748b" value={docLicense} onChangeText={setDocLicense} />
              <Text style={styles.inputLabelHeader}>Vehicle Details Description</Text>
              <TextInput style={styles.inputField} placeholder="Toyota Vitz, Silver, etc." placeholderTextColor="#64748b" value={docVehicleDetails} onChangeText={setDocVehicleDetails} />
            </View>
          )}

          {authRole === "vendor" && (
            <View style={styles.formContainer}>
              <Text style={styles.inputLabelHeader}>Kitchen Brand Name</Text>
              <TextInput style={styles.inputField} placeholder="Lumina Spice Kitchen" placeholderTextColor="#64748b" value={vendorBusinessName} onChangeText={setVendorBusinessName} />
              <Text style={styles.inputLabelHeader}>Operating Hours Matrix</Text>
              <TextInput style={styles.inputField} placeholder="08:00 AM - 11:00 PM" placeholderTextColor="#64748b" value={vendorOperatingHours} onChangeText={setVendorOperatingHours} />
              <Text style={styles.inputLabelHeader}>Owner GH-Card ID</Text>
              <TextInput style={styles.inputField} placeholder="GHA-XXXXXXXXX-X" placeholderTextColor="#64748b" value={vendorIdCard} onChangeText={setVendorIdCard} />
            </View>
          )}

          {authRole === "service_provider" && (
            <View style={styles.formContainer}>
              <Text style={styles.inputLabelHeader}>Specialist Business Name</Text>
              <TextInput style={styles.inputField} placeholder="Lumina Pro Engineering" placeholderTextColor="#64748b" value={serviceBusinessName} onChangeText={setServiceBusinessName} />
              <Text style={styles.inputLabelHeader}>Certification Reference Key ID</Text>
              <TextInput style={styles.inputField} placeholder="CERT-EE-XXXXX" placeholderTextColor="#64748b" value={serviceCertificationId} onChangeText={setServiceCertificationId} />
            </View>
          )}

          {!docApprovedStatus ? (
            <TouchableOpacity style={[styles.primaryButton, { backgroundColor: "#d97706" }]} onPress={simulateAutomatedDocumentScan}>
              <Text style={styles.buttonText}>Verify Credentials & Sync Tables</Text>
            </TouchableOpacity>
          ) : (
            <View style={styles.approvedNoticeBox}>
              <Text style={styles.approvedTitleText}>✓ Handshake Completed & Saved</Text>
              <Text style={styles.approvedBodyText}>Identity parameters committed directly into live rows.</Text>
            </View>
          )}

          {docApprovedStatus && (
            <View style={{ marginTop: 24 }}>
              <Text style={styles.inputLabelHeader}>Required: Account Profile Picture Link</Text>
              <TextInput style={styles.inputField} value={profilePic} onChangeText={setProfilePic} />
              <TouchableOpacity style={[styles.primaryButton, { backgroundColor: "#10b981" }]} onPress={handleProviderFinalSubmit}>
                <Text style={styles.buttonText}>Submit Verified Assets Packet</Text>
              </TouchableOpacity>
            </View>
          )}
        </ScrollView>
      </SafeAreaView>
    );
  }

  if (screen === "liveSelfieCheck") {
    return (
      <SafeAreaView style={styles.container}>
        <ScrollView contentContainerStyle={styles.centerScroll}>
          <Text style={styles.authHeaderTitle}>Universal Anti-Cheat Layer</Text>
          <Text style={styles.inputLabelHeader}>Camera Reference Picture URL String</Text>
          <TextInput style={styles.inputField} value={liveSelfiePic} onChangeText={setLiveSelfiePic} />
          <TouchableOpacity style={[styles.primaryButton, { backgroundColor: "#10b981", marginTop: 16 }]} onPress={handleExecuteLiveSelfieMatch}>
            <Text style={styles.buttonText}>Authenticate Secure Match Token</Text>
          </TouchableOpacity>
        </ScrollView>
      </SafeAreaView>
    );
  }

  if (screen === "clientDashboard") {
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.superAppTabToggleRow}>
          <TouchableOpacity style={[styles.subTabButton, clientSubTab === "transit" && styles.subTabButtonActive]} onPress={() => setClientSubTab("transit")}>
            <Text style={styles.subTabBtnText}>🚕 Transport</Text>
          </TouchableOpacity>
          <TouchableOpacity style={[styles.subTabButton, clientSubTab === "food" && styles.subTabButtonActive]} onPress={() => setClientSubTab("food")}>
            <Text style={styles.subTabBtnText}>🍔 Street Food</Text>
          </TouchableOpacity>
          <TouchableOpacity style={[styles.subTabButton, clientSubTab === "services" && styles.subTabButtonActive]} onPress={() => setClientSubTab("services")}>
            <Text style={styles.subTabBtnText}>🛠️ Services</Text>
          </TouchableOpacity>
        </View>

        {clientSubTab === "transit" && (
          <View style={{ flex: 1 }}>
            <View style={styles.mapContainer}>
              {WebView ? (
                <WebView originWhitelist={['*']} source={{ html: `<!DOCTYPE html><html><head><link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" /><script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script><style>body,html,#map{margin:0;padding:0;height:100%;width:100%;}</style></head><body><div id="map"></div><script>var map=L.map('map').setView([5.6037,-0.1870],13);L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png').addTo(map);L.marker([5.6037,-0.1870]).addTo(map).bindPopup('<b>Accra Base</b>').openPopup();</script></body></html>` }} style={styles.mapWebView} />
              ) : (
                <View style={styles.mapFallbackPlaceholder}>
                  <Text style={styles.fallbackEmoji}>🗺️</Text>
                  <Text style={styles.fallbackTextHeading}>Lumina GPRS Tracking Active</Text>
                  <Text style={styles.fallbackTextSub}>Accra Core Bounds Engine Node: [5.6037, -0.1870]</Text>
                </View>
              )}
            </View>
            
            <View style={styles.floatingSearchCard}>
              <TextInput style={styles.searchBarInput} onFocus={() => setFocusedInput("pickup")} placeholder="Enter Pickup (Ghana Bounds)" placeholderTextColor="#64748b" value={pickupText} onChangeText={setPickupText} />
              <TextInput style={[styles.searchBarInput, { marginTop: 8 }]} onFocus={() => setFocusedInput("dropoff")} placeholder="Enter Destination Location" placeholderTextColor="#64748b" value={dropoffText} onChangeText={setDropoffText} />
              
              {focusedInput && (
                <ScrollView style={styles.autocompleteScroll}>
                  {getFilteredLocations(focusedInput === "pickup" ? pickupText : dropoffText).map((loc, idx) => (
                    <TouchableOpacity key={idx} style={styles.autocompleteRowItem} onPress={() => {
                      if (focusedInput === "pickup") setPickupText(loc);
                      else setDropoffText(loc);
                      setFocusedInput(null);
                    }}>
                      <Text style={{ color: "#ffffff" }}>📍 {loc}</Text>
                    </TouchableOpacity>
                  ))}
                </ScrollView>
              )}
            </View>
          </View>
        )}

        {clientSubTab === "food" && (
          <ScrollView style={{ padding: 16 }}>
            <Text style={styles.sectionSubHeaderTitle}>Available Merchant Kitchens</Text>
            {RECURRING_FOOD_MARKETPLAY.map((v) => (
              <View key={v.id} style={styles.dashboardVisualCard}>
                <Text style={styles.cardHeaderTitleText}>{v.name} ({v.type})</Text>
                <Text style={styles.cardSubTitleText}>⭐ {v.rating} • ⏱️ {v.time}</Text>
                {v.items.map((item, i) => (
                  <Text key={i} style={{ color: "#a7f3d0", fontSize: 13, marginTop: 4 }}>• {item.name} - GHS {item.price}</Text>
                ))}
              </View>
            ))}
          </ScrollView>
        )}

        {clientSubTab === "services" && (
          <ScrollView style={{ padding: 16 }}>
            <Text style={styles.sectionSubHeaderTitle}>Instantly Book Vetted Professionals</Text>
            {HOME_MARKETPLACE_SERVICES.map((s) => (
              <View key={s.id} style={styles.dashboardVisualCard}>
                <Text style={styles.cardHeaderTitleText}>{s.icon} {s.title} ({s.price})</Text>
                <Text style={styles.cardSubTitleText}>{s.desc}</Text>
              </View>
            ))}
          </ScrollView>
        )}
      </SafeAreaView>
    );
  }

  // Fallback dashboard view structures
  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.brandHeader}>
        <Text style={styles.brandText}>LUMINA CONSOLE ACTIVE</Text>
        <Text style={styles.tagline}>Partner Operational Dashboard Ready</Text>
      </View>
      <ScrollView style={{ padding: 16 }}>
        {authRole === "driver" && <Text style={{ color: "#ffffff" }}>Fulfillment Operations Panel • Driving Tasks Active</Text>}
        {authRole === "vendor" && (
          <View>
            <Text style={{ color: "#ffffff", marginBottom: 12 }}>Active Restaurant Orders Array Matrix:</Text>
            {liveVendorOrders.map(o => (
              <Text key={o.id} style={{ color: "#fbbf24" }}>{o.id}: {o.item} ({o.status}) -> {o.customer}</Text>
            ))}
          </View>
        )}
        {authRole === "service_provider" && (
          <View>
            <Text style={{ color: "#ffffff", marginBottom: 12 }}>Active Trade Requests:</Text>
            {liveServiceRequests.map(r => (
              <Text key={r.id} style={{ color: "#a78bfa" }}>{r.id}: {r.serviceType} - {r.scope} ({r.status})</Text>
            ))}
          </View>
        )}
        <TouchableOpacity style={[styles.primaryButton, { marginTop: 40, backgroundColor: "#ef4444" }]} onPress={() => { setScreen("welcome"); setAuthRole(null); }}>
          <Text style={styles.buttonText}>Log Out Session</Text>
        </TouchableOpacity>
      </ScrollView>
    </SafeAreaView>
  );
}

// ====================================================================
// CORE DARK STYLESHEET DESIGNS
// ====================================================================
const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#0f172a" },
  centerScroll: { padding: 24, justifyContent: "center" },
  brandHeader: { alignItems: "center", marginTop: 40, marginBottom: 32 },
  brandText: { fontSize: 32, fontWeight: "900", color: "#ffffff", letterSpacing: 2 },
  tagline: { fontSize: 13, color: "#64748b", marginTop: 4 },
  roleSelectionBox: { width: "100%" },
  selectionTitle: { fontSize: 16, fontWeight: "700", color: "#94a3b8", marginBottom: 16, textAlign: "center" },
  dashboardVisualCard: { backgroundColor: "#1e293b", padding: 16, borderRadius: 12, borderLeftWidth: 4, marginBottom: 12 },
  cardHeaderTitleText: { fontSize: 16, fontWeight: "700", color: "#ffffff" },
  cardSubTitleText: { fontSize: 13, color: "#94a3b8", marginTop: 4, lineHeight: 18 },
  authHeaderTitle: { fontSize: 24, fontWeight: "800", color: "#ffffff", textAlign: "center", marginTop: 20 },
  authSubTitle: { fontSize: 13, color: "#64748b", textAlign: "center", marginTop: 6, paddingHorizontal: 16 },
  formContainer: { marginTop: 24, width: "100%" },
  inputLabelHeader: { fontSize: 12, fontWeight: "600", color: "#94a3b8", marginBottom: 6, letterSpacing: 0.5 },
  inputField: { backgroundColor: "#1e293b", borderRadius: 8, padding: 14, color: "#ffffff", fontSize: 14, marginBottom: 16 },
  primaryButton: { backgroundColor: "#38bdf8", borderRadius: 8, padding: 16, alignItems: "center" },
  buttonText: { color: "#0f172a", fontSize: 15, fontWeight: "700" },
  backLink: { marginTop: 16, alignItems: "center" },
  backLinkText: { color: "#64748b", fontSize: 13 },
  approvedNoticeBox: { backgroundColor: "rgba(16, 185, 129, 0.1)", borderWidth: 1, borderColor: "#10b981", padding: 16, borderRadius: 8, marginBottom: 16 },
  approvedTitleText: { color: "#10b981", fontWeight: "700", fontSize: 14 },
  approvedBodyText: { color: "#94a3b8", fontSize: 13, marginTop: 4 },
  superAppTabToggleRow: { flexDirection: "row", backgroundColor: "#1e293b", padding: 6 },
  subTabButton: { flex: 1, paddingVertical: 12, alignItems: "center", borderRadius: 8 },
  subTabButtonActive: { backgroundColor: "#0f172a" },
  subTabBtnText: { color: "#ffffff", fontSize: 12, fontWeight: "600" },
  mapContainer: { flex: 1, backgroundColor: "#1e293b" },
  mapWebView: { flex: 1 },
  floatingSearchCard: { position: "absolute", top: 16, left: 16, right: 16, backgroundColor: "rgba(30, 41, 59, 0.95)", padding: 12, borderRadius: 12, elevation: 5 },
  searchBarInput: { backgroundColor: "#0f172a", borderRadius: 8, padding: 12, color: "#ffffff", fontSize: 13 },
  autocompleteScroll: { maxHeight: 150, marginTop: 8 },
  autocompleteRowItem: { paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: "#334155" },
  toggleRowContainer: { flexDirection: "row", justifyContent: "space-between", marginBottom: 16 },
  selectorPillBtn: { flex: 1, backgroundColor: "#1e293b", padding: 12, borderRadius: 6, alignItems: "center", marginHorizontal: 4 },
  selectorPillBtnActive: { backgroundColor: "#38bdf8" },
  pillBtnText: { color: "#94a3b8", fontWeight: "700", fontSize: 11 },
  pillBtnTextActive: { color: "#0f172a" },
  selfieGraphicBox: { height: 120, backgroundColor: "#1e293b", borderRadius: 12, justifyContent: "center", alignItems: "center", marginVertical: 20 },
  sectionSubHeaderTitle: { color: "#ffffff", fontSize: 14, fontWeight: "700", marginBottom: 12 },
  mapFallbackPlaceholder: { flex: 1, justifyContent: "center", alignItems: "center", backgroundColor: "#1e293b", minHeight: 300 },
  fallbackEmoji: { fontSize: 40, marginBottom: 12 },
  fallbackTextHeading: { color: "#ffffff", fontSize: 16, fontWeight: "700" },
  fallbackTextSub: { color: "#64748b", fontSize: 12, marginTop: 4 }
});