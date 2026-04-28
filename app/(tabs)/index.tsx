import { supabase } from '../../lib/supabase';
import { View, Text, ScrollView, TouchableOpacity, StyleSheet, SafeAreaView, TextInput, Alert, Switch, Image, Linking } from "react-native";
import * as Location from "expo-location";
import * as ImagePicker from "expo-image-picker";

const searchPlaces = async (q) => {
  if(!q||q.length<3) return [];
  try {
    const r = await fetch("https://nominatim.openstreetmap.org/search?format=json&q="+encodeURIComponent(q)+"&limit=5",{headers:{"User-Agent":"LuminaLinks/1.0"}});
    return (await r.json()).map(p=>({name:p.display_name,lat:parseFloat(p.lat),lon:parseFloat(p.lon)}));
  } catch(e){ return []; }
};
const calcFare = (km) => {
  const pendingCount = (driverBookings||[]).filter(b=>b.status==="pending").length;
  const surgeMultiplier = pendingCount >= 10 ? 1.5 : pendingCount >= 5 ? 1.25 : pendingCount >= 3 ? 1.1 : 1.0;
  const base = 3.0;
  const perKm = 1.80;
  const fare = Math.max(8, base + km * perKm) * surgeMultiplier;
  const commission = fare * 0.10;
  const driverEarns = fare - commission;
  return fare.toFixed(2);
};
const getSurgeLabel = () => {
  const pendingCount = (driverBookings||[]).filter(b=>b.status==="pending").length;
  if(pendingCount>=10) return {label:"🔥 High Demand x1.5",color:"#f44336"};
  if(pendingCount>=5) return {label:"⚡ Busy x1.25",color:"#ff9800"};
  if(pendingCount>=3) return {label:"📈 Moderate x1.1",color:"#f5a623"};
  return {label:"✅ Normal Price",color:"#4caf50"};
};
const getDist = (lat1,lon1,lat2,lon2) => {
  if(!lat1||!lon1||!lat2||!lon2) return 0;
  const R=6371,dLat=(lat2-lat1)*Math.PI/180,dLon=(lon2-lon1)*Math.PI/180;
  const a=Math.sin(dLat/2)**2+Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLon/2)**2;
  return R*2*Math.atan2(Math.sqrt(a),Math.sqrt(1-a));
};
const USERS = [];
export default function App() {
  const [screen, setScreen] = useState("welcome");
  const [user, setUser] = useState(null);
  const [authMode, setAuthMode] = useState("login");
  const [authRole, setAuthRole] = useState(null);
  const [authName, setAuthName] = useState("");
  const [authEmail, setAuthEmail] = useState("");
  const [authPhone, setAuthPhone] = useState("");
  const [authPass, setAuthPass] = useState("");
  const [authConfirm, setAuthConfirm] = useState("");
  const [idPhoto, setIdPhoto] = useState(null);
  const [licFront, setLicFront] = useState(null);
  const [licBack, setLicBack] = useState(null);
  const [vehMake, setVehMake] = useState("");
  const [vehModel, setVehModel] = useState("");
  const [vehYear, setVehYear] = useState("");
  const [vehPlate, setVehPlate] = useState("");
  const [verifyStep, setVerifyStep] = useState(1);
  const [online, setOnline] = useState(false);
  const [location, setLocation] = useState(null);
  const [pickupText, setPickupText] = useState("");
  const [dropoffText, setDropoffText] = useState("");
  const [pickupPin, setPickupPin] = useState(null);
  const [dropoffPin, setDropoffPin] = useState(null);
  const [pickupSugg, setPickupSugg] = useState([]);
  const [dropoffSugg, setDropoffSugg] = useState([]);
  const [activeField, setActiveField] = useState(null);
  const [estFare, setEstFare] = useState(null);
  const [paymentMethod, setPaymentMethod] = useState("cash");
  const [showPaystack, setShowPaystack] = useState(false);
  const [activeBookingId, setActiveBookingId] = useState(null);
  const [chatMessages, setChatMessages] = useState([]);
  const [chatInput, setChatInput] = useState("");
  const [driverLiveLocation, setDriverLiveLocation] = useState(null);
  const [ratingBookingId, setRatingBookingId] = useState(null);
  const [selectedRating, setSelectedRating] = useState(0);
  const [sosActive, setSosActive] = useState(false);
  const [driverProfile, setDriverProfile] = useState(null);
  const [paystackAmount, setPaystackAmount] = useState(0);
  const [paystackEmail, setPaystackEmail] = useState("");
  const [estKm, setEstKm] = useState(null);
  const [clientBookings, setClientBookings] = useState([]);
  const [clientRatings, setClientRatings] = useState({});
  const [pinMode, setPinMode] = useState(null);
  const [driverBookings, setDriverBookings] = useState([]);
  const ptRef = useRef(null);
  const dtRef = useRef(null);
  const go = (s) => setScreen(s);
  const fetchDriverBookings = async () => {
    const { data, error } = await supabase
      .from('bookings')
      .select('*')
      .order('created_at', { ascending: false });
    if (data) setDriverBookings(data);
  };


  useEffect(() => {
    if (screen === "clientOrders") fetchDriverBookings();
    if (screen === "clientHome" || screen === "myBookings") fetchClientBookings();
  }, [screen]);

  const acceptOrder = async (bookingId) => {
    const {data:{user}} = await supabase.auth.getUser();
    if (!user) return;
    const {error} = await supabase.from('bookings').update({status:'accepted',driver_id:user.id,driverName:user.user_metadata?.full_name||user.email,driverPhone:user.user_metadata?.phone||''}).eq('id',bookingId);
    if (!error) {
      setActiveBookingId(bookingId);
    watchDriverLocation(bookingId);
    fetchMessages(bookingId);
    go("activeRide");
    Alert.alert("Accepted!","You have accepted this ride.");
    supabase.from('bookings').select('client_id').eq('id',bookingId).single().then(({data:bk})=>{
      if(bk?.client_id){supabase.from('profiles').select('push_token').eq('id',bk.client_id).single().then(({data:p})=>{
        if(p?.push_token)sendPushNotification(p.push_token,'✅ Driver Accepted!','Your driver is on the way!');
      });}
    });
      fetchDriverBookings();
    } else {
      Alert.alert("Error", error.message);
    }
  };

  useEffect(() => {
    if (screen === "clientOrders") {
      fetchDriverBookings();
      const interval = setInterval(fetchDriverBookings, 10000);
      return () => clearInterval(interval);
    }
  }, [screen]);


  const sendMessage = async (bookingId) => {
    if (!chatInput.trim()) return;
    const { data: { user } } = await supabase.auth.getUser();
    await supabase.from('messages').insert({
      booking_id: bookingId,
      sender_id: user.id,
      sender_name: user.name || user.email,
      message: chatInput.trim()
    });
    setChatInput("");
    fetchMessages(bookingId);
  };

  const fetchMessages = async (bookingId) => {
    const { data } = await supabase.from('messages').select('*').eq('booking_id', bookingId).order('created_at', { ascending: true });
    if (data) setChatMessages(data);
  };

  const updateDriverLocation = async (bookingId) => {
    const { status } = await Location.requestForegroundPermissionsAsync();
    if (status !== 'granted') return;
    const loc = await Location.getCurrentPositionAsync({});
    await supabase.from('bookings').update({ driver_lat: loc.coords.latitude, driver_lng: loc.coords.longitude }).eq('id', bookingId);
  };

  const watchDriverLocation = async (bookingId) => {
    const { status } = await Location.requestForegroundPermissionsAsync();
    if (status !== 'granted') return;
    await Location.watchPositionAsync({ accuracy: Location.Accuracy.High, timeInterval: 5000, distanceInterval: 10 }, (loc) => {
      supabase.from('bookings').update({ driver_lat: loc.coords.latitude, driver_lng: loc.coords.longitude }).eq('id', bookingId);
    });
  };

  const fetchDriverLocation = async (bookingId) => {
    const { data } = await supabase.from('bookings').select('driver_lat,driver_lng').eq('id', bookingId).single();
    if (data?.driver_lat) setDriverLiveLocation({ latitude: data.driver_lat, longitude: data.driver_lng });
  };

  const registerPushToken = async () => {
    // Push notifications - coming soon
  };

  const sendPushNotification = async (pushToken, title, body) => {
    if (!pushToken) return;
    await fetch('https://exp.host/--/api/v2/push/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ to: pushToken, title, body, sound: 'default' }),
    });
  };

  const fetchClientBookings = async () => {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;
    const { data, error } = await supabase
      .from('bookings')
      .select('*')
      .eq('client_id', user.id)
      .order('created_at', { ascending: false });
    if (data) setClientBookings(data);
  };

  const saveBookingToSupabase = async (pickup, dropoff, service, price) => {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;
    await supabase.from('bookings').insert({
      client_id: user.id,
      client_name: authName,
      pickup: pickup,
      dropoff: dropoff,
      service: service,
      price: price,
      status: 'pending'
    });
  };
  const pickupChange = (t) => {
    setPickupText(t); setActiveField("pickup");
    clearTimeout(ptRef.current);
    ptRef.current = setTimeout(async()=>setPickupSugg(await searchPlaces(t)),600);
  };
  const dropoffChange = (t) => {
    setDropoffText(t); setActiveField("dropoff");
    clearTimeout(dtRef.current);
    dtRef.current = setTimeout(async()=>setDropoffSugg(await searchPlaces(t)),600);
  };
  const selPickup = (p) => {
    setPickupText(p.name); setPickupPin({latitude:p.lat,longitude:p.lon});
    setPickupSugg([]); setActiveField(null);
    if(dropoffPin){const km=getDist(p.lat,p.lon,dropoffPin.latitude,dropoffPin.longitude);setEstKm(km.toFixed(2));setEstFare(calcFare(km));}
  };
  const selDropoff = (p) => {
    setDropoffText(p.name); setDropoffPin({latitude:p.lat,longitude:p.lon});
    setDropoffSugg([]); setActiveField(null);
    if(pickupPin){const km=getDist(pickupPin.latitude,pickupPin.longitude,p.lat,p.lon);setEstKm(km.toFixed(2));setEstFare(calcFare(km));}
  };
  const handleMapPress = (e) => {
    const c=e.nativeEvent.coordinate;
    if(pinMode==="pickup"){setPickupPin(c);setPickupText(c.latitude.toFixed(4)+", "+c.longitude.toFixed(4));setPinMode(null);setPickupSugg([]);}
    else if(pinMode==="dropoff"){setDropoffPin(c);setDropoffText(c.latitude.toFixed(4)+", "+c.longitude.toFixed(4));setPinMode(null);setDropoffSugg([]);}
  };
  const pickPhoto = async (setter) => {
    const {status} = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if(status!=="granted"){Alert.alert("Permission needed");return;}
    const r = await ImagePicker.launchImageLibraryAsync({mediaTypes:ImagePicker.MediaTypeOptions.Images,quality:0.7});
    if(!r.canceled) setter(r.assets[0].uri);
  };
  const doSignup = async () => {
    if(!authName||!authEmail||!authPass){Alert.alert("Error","Please fill all fields");return;}
    if(authPass!==authConfirm){Alert.alert("Error","Passwords do not match");return;}
    const {data,error} = await supabase.auth.signUp({email:authEmail,password:authPass});
    if(error){Alert.alert("Error",error.message);return;}
    await supabase.from('profiles').insert({id:data.user?.id,full_name:authName,email:authEmail,phone:authPhone,account_type:authRole,verified:authRole==="client"});
    const u={name:authName,email:authEmail,phone:authPhone,pass:authPass,role:authRole,verified:authRole==="client"};
    setUser(u);
    if(authRole==="driver"){setVerifyStep(1);go("verify");}else{go("clientHome");}
  };
  const doLogin = async () => {
    if(!authEmail||!authPass){Alert.alert("Error","Please enter email and password");return;}
    if(authEmail==="driver@demo.com"){setUser({name:"Sam Driver",email:authEmail,role:"driver",verified:true,phone:"+233 55 000 0001"});go("driverHome");return;}
    if(authEmail==="client@demo.com"){setUser({name:"Alex Client",email:authEmail,role:"client",verified:true,phone:"+233 55 000 0002"});go("clientHome");return;}
    const {data,error} = await supabase.auth.signInWithPassword({email:authEmail,password:authPass});
    if(error){Alert.alert("Error",error.message);return;}
    const {data:profile} = await supabase.from('profiles').select('*').eq('id',data.user?.id).single();
    if(!profile){Alert.alert("Error","Profile not found");return;}
    const u={name:profile.full_name,email:profile.email,phone:profile.phone,role:profile.account_type,verified:profile.verified};
    setUser(u);
    if(u.role==="driver"){u.verified?go("driverHome"):go("pending");}else{go("clientHome");}registerPushToken();
  };
  const submitVerify = () => {
    if(!idPhoto||!licFront||!licBack){Alert.alert("Missing","Please upload all documents");return;}
    if(!vehMake||!vehModel||!vehPlate){Alert.alert("Missing","Please fill vehicle info");return;}
    go("pending");
  };
  const submitRide = () => {
    if(!pickupText||!dropoffText){Alert.alert("Missing","Please enter pickup and dropoff");return;}
    if(paymentMethod==="momo"||paymentMethod==="card"){
      Alert.alert(
        "Confirm Payment",
        `You will be charged GHS ${estFare||20} via ${paymentMethod==="momo"?"Mobile Money":"Card"}. Please have your phone ready.`,
        [
          {text:"Cancel",style:"cancel"},
          {text:"Confirm",onPress:()=>processBooking()}
        ]
      );
      return;
    }
    processBooking();
  };
  const processBooking = () => {
    const nb={id:Date.now(),service:"Ride Request",time:new Date().toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"}),status:"pending",price:parseFloat(estFare||20),pickup:pickupText,dropoff:dropoffText,rated:false,driverName:user?.name||"Driver",driverPhone:user?.phone||"",km:estKm};
    setClientBookings(prev=>[nb,...prev]);
    setDriverBookings(prev=>[{...nb,id:Date.now()+1,client:user&&user.name?user.name:"Client",payment:paymentMethod},...prev]);
  saveBookingToSupabase(pickupText,dropoffText,"Ride Request",parseFloat(estFare||20));
    supabase.from('profiles').select('push_token').eq('account_type','driver').eq('verified',true).then(({data})=>{
      data?.forEach(d=>{if(d.push_token)sendPushNotification(d.push_token,'🚗 New Ride Request!',`From: ${pickupText} → ${dropoffText}`);});
    });
    Alert.alert("Ride Booked!","Driver is on the way! Fare: $"+nb.price,[{text:"OK",onPress:()=>go("clientOrders")}]);
    setPickupText("");setDropoffText("");setPickupPin(null);setDropoffPin(null);setEstFare(null);setEstKm(null);
  };
  const rateDriver = (id,stars) => {
    setClientBookings(prev=>prev.map(b=>b.id===id?{...b,rated:true,rating:stars}:b));
    setClientRatings(prev=>({...prev,[id]:stars}));
    Alert.alert("Thanks!","You rated "+stars+" stars!");
  };
  const logout = () => {setUser(null);setAuthEmail("");setAuthPass("");setAuthName("");go("welcome");};
  const s = StyleSheet.create({
    safe:{flex:1,backgroundColor:"#0a0a0a"},
    center:{flex:1,backgroundColor:"#0a0a0a",justifyContent:"center",alignItems:"center",padding:24},
    nav:{flexDirection:"row",justifyContent:"space-between",alignItems:"center",padding:16,borderBottomWidth:1,borderBottomColor:"#222"},
    navLogo:{color:"#c9a84c",fontSize:18,fontWeight:"bold"},
    navLink:{color:"#c9a84c",fontSize:14},
    title:{color:"#fff",fontSize:26,fontWeight:"bold",marginBottom:4},
    input:{backgroundColor:"#1a1a1a",color:"#fff",borderRadius:10,padding:14,marginBottom:12,fontSize:15},
    btn:{backgroundColor:"#c9a84c",borderRadius:10,padding:16,alignItems:"center",marginTop:8},
    btnTxt:{color:"#000",fontWeight:"bold",fontSize:16},
    btnOut:{borderWidth:1,borderColor:"#c9a84c",borderRadius:10,padding:16,alignItems:"center",marginTop:8},
    btnOutTxt:{color:"#c9a84c",fontWeight:"bold",fontSize:16},
    btnBlue:{backgroundColor:"#1a2a3a",borderWidth:1,borderColor:"#2196f3",borderRadius:10,padding:16,alignItems:"center",marginTop:8},
    btnGreen:{backgroundColor:"#1a3a2a",borderWidth:1,borderColor:"#4caf50",borderRadius:10,padding:14,alignItems:"center",marginTop:8},
    card:{backgroundColor:"#1a1a1a",borderRadius:12,padding:16,marginBottom:12},
    cardTitle:{color:"#fff",fontSize:16,fontWeight:"600"},
    cardSub:{color:"#888",fontSize:13,marginTop:2},
    cardLoc:{color:"#555",fontSize:12,marginTop:3},
    badge:{paddingHorizontal:10,paddingVertical:4,borderRadius:20,alignSelf:"flex-start",marginTop:6},
    sectionTitle:{color:"#c9a84c",fontSize:13,fontWeight:"700",letterSpacing:1,marginBottom:10,marginTop:12},
    row:{flexDirection:"row",gap:8,marginBottom:16},
    statCard:{backgroundColor:"#1a1a1a",borderRadius:12,padding:12,alignItems:"center",flex:1},
    statVal:{color:"#c9a84c",fontSize:18,fontWeight:"bold"},
    statLabel:{color:"#888",fontSize:11,marginTop:4},
    roleBtn:{borderRadius:16,padding:24,alignItems:"center",marginBottom:16,borderWidth:2},
    uploadBox:{backgroundColor:"#1a1a1a",borderRadius:12,borderWidth:2,borderColor:"#333",padding:20,alignItems:"center",marginBottom:12},
    uploadImg:{width:"100%",height:150,borderRadius:10,resizeMode:"cover"},
    map:{width:"100%",height:200,borderRadius:12,marginBottom:8},
    suggestBox:{backgroundColor:"#1e1e1e",borderRadius:10,marginBottom:8,borderWidth:1,borderColor:"#333"},
    suggestItem:{padding:12,borderBottomWidth:1,borderBottomColor:"#2a2a2a"},
    suggestTxt:{color:"#fff",fontSize:13},
    fareBox:{backgroundColor:"#1a2a1a",borderRadius:12,padding:14,marginBottom:8,borderWidth:1,borderColor:"#4caf50"},
    contactRow:{flexDirection:"row",gap:8,marginTop:8},
    contactBtn:{flex:1,borderRadius:10,padding:10,alignItems:"center"},
    onlineRow:{flexDirection:"row",justifyContent:"space-between",alignItems:"center",backgroundColor:"#1a1a1a",borderRadius:12,padding:14,marginBottom:12},
    pinRow:{flexDirection:"row",gap:8,marginBottom:8},
    pinBtn:{borderRadius:10,padding:10,alignItems:"center",flex:1},
    divider:{flexDirection:"row",alignItems:"center",marginVertical:16},
    dividerLine:{flex:1,height:1,backgroundColor:"#222"},
    dividerTxt:{color:"#888",marginHorizontal:12},
    verifyStep:{flexDirection:"row",alignItems:"center",backgroundColor:"#1a1a1a",borderRadius:12,padding:14,marginBottom:10},
    verifyNum:{width:32,height:32,borderRadius:16,backgroundColor:"#c9a84c",alignItems:"center",justifyContent:"center",marginRight:12},
  });
  if(screen==="welcome") return (
    <SafeAreaView style={s.safe}>
      <View style={s.center}>
        <Text style={{color:"#c9a84c",fontSize:40,fontWeight:"bold",marginBottom:8}}>Lumina Links</Text>
        <Text style={{color:"#888",fontSize:16,marginBottom:40,textAlign:"center"}}>Your city, connected.</Text>
        <TouchableOpacity style={[s.btn,{width:"100%"}]} onPress={()=>{setAuthMode("login");go("auth");}}>
          <Text style={s.btnTxt}>Log In</Text>
        </TouchableOpacity>
        <TouchableOpacity style={[s.btnOut,{width:"100%"}]} onPress={()=>{setAuthMode("signup");setAuthRole(null);go("roleSelect");}}>
          <Text style={s.btnOutTxt}>Create Account</Text>
        </TouchableOpacity>
        <Text style={{color:"#555",fontSize:12,marginTop:24,textAlign:"center"}}>Demo: driver@demo.com or client@demo.com</Text>
      </View>
    </SafeAreaView>
  );
  if(screen==="roleSelect") return (
    <SafeAreaView style={s.safe}>
      <View style={s.nav}>
        <TouchableOpacity onPress={()=>go("welcome")}><Text style={s.navLink}>Back</Text></TouchableOpacity>
        <Text style={s.navLogo}>Create Account</Text>
        <View/>
      </View>
      <View style={{padding:24,flex:1,justifyContent:"center"}}>
        <Text style={[s.title,{textAlign:"center"}]}>I am a...</Text>
        <Text style={{color:"#888",textAlign:"center",marginBottom:32}}>Choose your role</Text>
        <TouchableOpacity style={[s.roleBtn,{borderColor:authRole==="driver"?"#c9a84c":"#222",backgroundColor:authRole==="driver"?"#2a2000":"#1a1a1a"}]} onPress={()=>setAuthRole("driver")}>
          <Text style={{fontSize:48}}>🚗</Text>
          <Text style={{color:authRole==="driver"?"#c9a84c":"#fff",fontSize:18,fontWeight:"bold",marginTop:8}}>Driver</Text>
          <Text style={{color:"#888",fontSize:13,marginTop:4,textAlign:"center"}}>Earn money providing rides</Text>
        </TouchableOpacity>
        <TouchableOpacity style={[s.roleBtn,{borderColor:authRole==="client"?"#2196f3":"#222",backgroundColor:authRole==="client"?"#001a2a":"#1a1a1a"}]} onPress={()=>setAuthRole("client")}>
          <Text style={{fontSize:48}}>👤</Text>
          <Text style={{color:authRole==="client"?"#2196f3":"#fff",fontSize:18,fontWeight:"bold",marginTop:8}}>Client</Text>
          <Text style={{color:"#888",fontSize:13,marginTop:4,textAlign:"center"}}>Book rides and services</Text>
        </TouchableOpacity>
        {authRole&&<TouchableOpacity style={s.btn} onPress={()=>go("auth")}><Text style={s.btnTxt}>Continue as {authRole==="driver"?"Driver":"Client"}</Text></TouchableOpacity>}
      </View>
    </SafeAreaView>
  );
  if(screen==="auth") return (
    <SafeAreaView style={s.safe}>
      <View style={s.nav}>
        <TouchableOpacity onPress={()=>go(authMode==="login"?"welcome":"roleSelect")}><Text style={s.navLink}>Back</Text></TouchableOpacity>
        <Text style={s.navLogo}>{authMode==="login"?"Log In":"Sign Up"}</Text>
        <View/>
      </View>
      <ScrollView contentContainerStyle={{padding:24}}>
        {authMode==="signup"&&(
          <>
            <Text style={s.sectionTitle}>YOUR DETAILS</Text>
            <TextInput style={s.input} placeholder="Full Name" placeholderTextColor="#555" value={authName} onChangeText={setAuthName}/>
            <TextInput style={s.input} placeholder="Phone Number" placeholderTextColor="#555" value={authPhone} onChangeText={setAuthPhone} keyboardType="phone-pad"/>
          </>
        )}
        <Text style={s.sectionTitle}>ACCOUNT</Text>
        <TextInput style={s.input} placeholder="Email Address" placeholderTextColor="#555" value={authEmail} onChangeText={setAuthEmail} keyboardType="email-address" autoCapitalize="none"/>
        <TextInput style={s.input} placeholder="Password" placeholderTextColor="#555" value={authPass} onChangeText={setAuthPass} secureTextEntry/>
        {authMode==="signup"&&<TextInput style={s.input} placeholder="Confirm Password" placeholderTextColor="#555" value={authConfirm} onChangeText={setAuthConfirm} secureTextEntry/>}
        <TouchableOpacity style={s.btn} onPress={authMode==="login"?doLogin:doSignup}>
          <Text style={s.btnTxt}>{authMode==="login"?"Log In":"Create Account"}</Text>
        </TouchableOpacity>
        <View style={s.divider}><View style={s.dividerLine}/><Text style={s.dividerTxt}>OR</Text><View style={s.dividerLine}/></View>
        <TouchableOpacity style={s.btnOut} onPress={()=>setAuthMode(authMode==="login"?"signup":"login")}>
          <Text style={s.btnOutTxt}>{authMode==="login"?"Create New Account":"Already have an account? Log In"}</Text>
        </TouchableOpacity>
      </ScrollView>
    </SafeAreaView>
  );
  if(screen==="verify") return (
    <SafeAreaView style={s.safe}>
      <View style={s.nav}>
        <View/><Text style={s.navLogo}>Driver Verification</Text><View/>
      </View>
      <ScrollView contentContainerStyle={{padding:20}}>
        <Text style={{color:"#fff",fontSize:18,fontWeight:"bold",marginBottom:4}}>Welcome, {user&&user.name}!</Text>
        <WebView key={`map-${location?.latitude||6.6}`} style={{width:"100%",height:220,borderRadius:12,marginBottom:12,overflow:"hidden"}} source={{html:`<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"/><script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script><style>html,body,#map{height:100%;margin:0}</style></head><body><div id="map"></div><script>var lat=${location?.latitude||6.6},lng=${location?.longitude||-1.6};var map=L.map("map").setView([lat,lng],15);L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png").addTo(map);L.marker([lat,lng]).addTo(map);</script></body></html>`}}/>
        <Text style={{color:"#888",fontSize:14,marginBottom:20}}>Complete verification to start driving</Text>
        {verifyStep===1&&(
          <>
            <Text style={s.sectionTitle}>STEP 1 OF 3 - IDENTITY DOCUMENT</Text>
            <View style={s.verifyStep}>
              <View style={s.verifyNum}><Text style={{color:"#000",fontWeight:"bold"}}>1</Text></View>
              <View><Text style={{color:"#fff",fontSize:15,fontWeight:"600"}}>National ID or Passport</Text>
              <Text style={{color:"#888",fontSize:12,marginTop:2}}>Clear photo of your government ID</Text></View>
            </View>
            <TouchableOpacity style={s.uploadBox} onPress={()=>pickPhoto(setIdPhoto)}>
              {idPhoto?<Image source={{uri:idPhoto}} style={s.uploadImg}/>:<>
                <Text style={{fontSize:40}}>🪪</Text>
                <Text style={{color:"#888",marginTop:8}}>Tap to upload ID photo</Text>
              </>}
            </TouchableOpacity>
            {idPhoto&&<TouchableOpacity style={s.btn} onPress={()=>setVerifyStep(2)}><Text style={s.btnTxt}>Next: Drivers License</Text></TouchableOpacity>}
          </>
        )}
        {verifyStep===2&&(
          <>
            <Text style={s.sectionTitle}>STEP 2 OF 3 - DRIVERS LICENSE</Text>
            <View style={s.verifyStep}>
              <View style={s.verifyNum}><Text style={{color:"#000",fontWeight:"bold"}}>2</Text></View>
              <View><Text style={{color:"#fff",fontSize:15,fontWeight:"600"}}>Drivers License</Text>
              <Text style={{color:"#888",fontSize:12,marginTop:2}}>Upload front and back</Text></View>
            </View>
            <Text style={{color:"#888",marginBottom:6}}>Front side:</Text>
            <TouchableOpacity style={s.uploadBox} onPress={()=>pickPhoto(setLicFront)}>
              {licFront?<Image source={{uri:licFront}} style={s.uploadImg}/>:<>
                <Text style={{fontSize:36}}>📄</Text>
                <Text style={{color:"#888",marginTop:8}}>Tap to upload front</Text>
              </>}
            </TouchableOpacity>
            <Text style={{color:"#888",marginBottom:6}}>Back side:</Text>
            <TouchableOpacity style={s.uploadBox} onPress={()=>pickPhoto(setLicBack)}>
              {licBack?<Image source={{uri:licBack}} style={s.uploadImg}/>:<>
                <Text style={{fontSize:36}}>📄</Text>
                <Text style={{color:"#888",marginTop:8}}>Tap to upload back</Text>
              </>}
            </TouchableOpacity>
            <View style={{flexDirection:"row",gap:8,marginTop:8}}>
              <TouchableOpacity style={[s.btnOut,{flex:1}]} onPress={()=>setVerifyStep(1)}><Text style={s.btnOutTxt}>Back</Text></TouchableOpacity>
              {licFront&&licBack&&<TouchableOpacity style={[s.btn,{flex:2}]} onPress={()=>setVerifyStep(3)}><Text style={s.btnTxt}>Next: Vehicle</Text></TouchableOpacity>}
            </View>
          </>
        )}
        {verifyStep===3&&(
          <>
            <Text style={s.sectionTitle}>STEP 3 OF 3 - VEHICLE INFO</Text>
            <View style={s.verifyStep}>
              <View style={s.verifyNum}><Text style={{color:"#000",fontWeight:"bold"}}>3</Text></View>
              <View><Text style={{color:"#fff",fontSize:15,fontWeight:"600"}}>Your Vehicle</Text>
              <Text style={{color:"#888",fontSize:12,marginTop:2}}>Details of vehicle you will use</Text></View>
            </View>
            <TextInput style={s.input} placeholder="Vehicle Make (e.g. Toyota)" placeholderTextColor="#555" value={vehMake} onChangeText={setVehMake}/>
            <TextInput style={s.input} placeholder="Vehicle Model (e.g. Corolla)" placeholderTextColor="#555" value={vehModel} onChangeText={setVehModel}/>
            <TextInput style={s.input} placeholder="Year (e.g. 2020)" placeholderTextColor="#555" value={vehYear} onChangeText={setVehYear} keyboardType="numeric"/>
            <TextInput style={s.input} placeholder="Plate Number" placeholderTextColor="#555" value={vehPlate} onChangeText={setVehPlate} autoCapitalize="characters"/>
            <View style={{flexDirection:"row",gap:8,marginTop:8}}>
              <TouchableOpacity style={[s.btnOut,{flex:1}]} onPress={()=>setVerifyStep(2)}><Text style={s.btnOutTxt}>Back</Text></TouchableOpacity>
              <TouchableOpacity style={[s.btn,{flex:2}]} onPress={submitVerify}><Text style={s.btnTxt}>Submit for Review</Text></TouchableOpacity>
            </View>
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
  if(screen==="pending") return (
    <SafeAreaView style={s.safe}>
      <View style={s.nav}>
        <Text style={s.navLogo}>Lumina Links</Text>
        <TouchableOpacity onPress={logout}><Text style={s.navLink}>Log Out</Text></TouchableOpacity>
      </View>
      <ScrollView contentContainerStyle={{padding:20,alignItems:"center",justifyContent:"center",flex:1}}>
        <Text style={{fontSize:40,marginBottom:16}}>⏳</Text>
        <Text style={{color:"#fff",fontSize:20,fontWeight:"bold",textAlign:"center",marginBottom:8}}>Application Under Review</Text>
        <Text style={{color:"#888",fontSize:14,textAlign:"center",marginBottom:24}}>Your driver application is being reviewed by our team. You will be notified once approved.</Text>
        <TouchableOpacity style={s.btn} onPress={()=>go("verify")}>
          <Text style={s.btnTxt}>Complete Verification</Text>
        </TouchableOpacity>
      </ScrollView>
    </SafeAreaView>
  );
if(screen==="clientOrders") return (
    <SafeAreaView style={s.safe}>
      <View style={s.nav}>
        <TouchableOpacity onPress={()=>go("driverHome")}><Text style={s.navLink}>Back</Text></TouchableOpacity>
        <Text style={s.navLogo}>Orders</Text>
        <View/>
      </View>
      <ScrollView contentContainerStyle={{padding:20}}>
        <Text style={{color:"#fff",fontSize:18,fontWeight:"bold",marginBottom:16}}>Incoming Orders</Text>
        {driverBookings.length===0?(
          <Text style={{color:"#888",textAlign:"center",marginTop:40}}>No orders yet. Waiting for clients...</Text>
        ):(
          driverBookings.map((b,i)=>(
            <View key={i} style={s.card}>
              <Text style={s.cardTitle}>🚗 Ride Request</Text>
              <Text style={{color:"#888"}}>From: {b.pickup}</Text>
              <Text style={{color:"#888"}}>To: {b.dropoff}</Text>
          <Text style={{color:"#c9a84c",fontWeight:"bold"}}>GHS {b.price}</Text>
          {b.status==="pending"&&<TouchableOpacity onPress={()=>acceptOrder(b.id)} style={{marginTop:8,backgroundColor:"#4caf50",padding:8,borderRadius:8,alignItems:"center"}}><Text style={{color:"#fff",fontWeight:"bold"}}>✅ Accept Ride</Text></TouchableOpacity>}
          {b.status==="completed"&&!b.rating&&<TouchableOpacity onPress={()=>{setRatingBookingId(b.id);setSelectedRating(0);go("rateDriver");}} style={{backgroundColor:"#1a2a1a",borderRadius:8,padding:8,marginTop:6,borderWidth:1,borderColor:"#4caf50"}}>
              <Text style={{color:"#4caf50",fontWeight:"bold",textAlign:"center"}}>⭐ Rate Your Driver</Text>
            </TouchableOpacity>}
            {b.status==="accepted"&&<TouchableOpacity onPress={()=>{setActiveBookingId(b.id);fetchMessages(b.id);fetchDriverLocation(b.id);go("clientRide");}}> style={{backgroundColor:"#1a2a3a",borderRadius:8,padding:8,marginTop:6,borderWidth:1,borderColor:"#2196f3"}}>
              <Text style={{color:"#2196f3",fontWeight:"bold",textAlign:"center"}}>📍 Track Driver & Chat</Text>
            </TouchableOpacity>}
            {b.status==="accepted"&&<Text style={{color:"#4caf50",marginTop:6,fontWeight:"bold",textAlign:"center"}}>✅ Accepted</Text>}
            </View>
          ))
        )}
      </ScrollView>
    </SafeAreaView>
  );
if(screen==="clientRide") return (
  <SafeAreaView style={s.safe}>
    <View style={s.nav}>
      <TouchableOpacity onPress={()=>go("myBookings")}><Text style={s.navLink}>← Back</Text></TouchableOpacity>
      <Text style={s.navLogo}>🚗 Your Ride</Text>
      <View/>
    </View>
    <View style={{flex:1}}>
      <WebView style={{height:250}} source={{html:`<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"/><script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script></head><body style="margin:0"><div id="map" style="height:250px"></div><script>var map=L.map("map").setView([${driverLiveLocation?.latitude||location?.latitude||6.6},${driverLiveLocation?.longitude||location?.longitude||-1.6}],15);L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png").addTo(map);${driverLiveLocation?`L.marker([${driverLiveLocation.latitude},${driverLiveLocation.longitude}]).bindPopup("Your Driver").addTo(map);`:""}${location?`L.marker([${location.latitude},${location.longitude}]).bindPopup("You").addTo(map);`:""}</script></body></html>`}}/>
      <View style={{backgroundColor:"#1a1a1a",margin:8,padding:12,borderRadius:10,borderWidth:1,borderColor:"#333",flexDirection:"row",alignItems:"center",gap:12}}>
        <Text style={{fontSize:32}}>🧑‍✈️</Text>
        <View style={{flex:1}}>
          <Text style={{color:"#fff",fontWeight:"bold"}}>{driverProfile?.full_name||"Your Driver"}</Text>
          <Text style={{color:"#888",fontSize:12}}>{driverProfile?.phone||""}</Text>
          <Text style={{color:"#f5a623",fontSize:12}}>⭐ {driverProfile?.avg_rating||"New Driver"}</Text>
        </View>
        <Text style={{color:"#4caf50",fontWeight:"bold",fontSize:13}}>ACTIVE</Text>
      </View>
      <View style={{flexDirection:"row",gap:8,margin:8}}>
        <TouchableOpacity style={[s.btn,{flex:2,backgroundColor:"#1a2a3a",borderColor:"#2196f3",borderWidth:1}]} onPress={()=>fetchDriverLocation(activeBookingId)}>
          <Text style={[s.btnTxt,{color:"#2196f3",fontSize:13}]}>🔄 Refresh Driver Location</Text>
        </TouchableOpacity>
        <TouchableOpacity style={[s.btn,{flex:1,backgroundColor:"#3a1a1a",borderColor:"#f44336",borderWidth:1}]} onPress={()=>{setSosActive(true);Alert.alert("🚨 SOS","Emergency services have been alerted. Stay calm.");}}>
          <Text style={[s.btnTxt,{color:"#f44336",fontSize:13}]}>🚨 SOS</Text>
        </TouchableOpacity>
      </View>
      <ScrollView style={{flex:1,padding:12}}>
        <Text style={{color:"#888",fontSize:12,textAlign:"center",marginBottom:8}}>Chat with your driver</Text>
        {chatMessages.map((m,i)=>(
          <View key={i} style={{alignSelf:m.sender_id===user?.id?"flex-end":"flex-start",backgroundColor:m.sender_id===user?.id?"#2196f3":"#333",padding:10,borderRadius:12,marginBottom:6,maxWidth:"80%"}}>
            <Text style={{color:"#fff",fontSize:13}}>{m.message}</Text>
            <Text style={{color:"rgba(255,255,255,0.6)",fontSize:10}}>{m.sender_name}</Text>
          </View>
        ))}
      </ScrollView>
      <View style={{flexDirection:"row",padding:8,gap:8,backgroundColor:"#111"}}>
        <TextInput value={chatInput} onChangeText={setChatInput} placeholder="Type a message..." placeholderTextColor="#555" style={{flex:1,backgroundColor:"#1a1a1a",color:"#fff",borderRadius:20,paddingHorizontal:16,paddingVertical:8,borderWidth:1,borderColor:"#333"}}/>
        <TouchableOpacity onPress={()=>{sendMessage(activeBookingId);fetchMessages(activeBookingId);}} style={{backgroundColor:"#f5a623",borderRadius:20,paddingHorizontal:16,paddingVertical:8,justifyContent:"center"}}>
          <Text style={{color:"#000",fontWeight:"bold"}}>Send</Text>
        </TouchableOpacity>
      </View>
    </View>
  </SafeAreaView>
);
if(screen==="activeRide") return (
  <SafeAreaView style={s.safe}>
    <View style={s.nav}>
      <Text style={s.navLogo}>🚗 Active Ride</Text>
      <TouchableOpacity onPress={()=>{go("clientOrders");}}><Text style={s.navLink}>Done</Text></TouchableOpacity>
    </View>
    <View style={{flex:1}}>
      <WebView style={{height:250}} source={{html:`<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"/><script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script></head><body style="margin:0"><div id="map" style="height:250px"></div><script>var map=L.map("map").setView([${location?.latitude||6.6},${location?.longitude||-1.6}],15);L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png").addTo(map);${driverLiveLocation?`L.marker([${driverLiveLocation.latitude},${driverLiveLocation.longitude}],{icon:L.icon({iconUrl:"https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png",iconSize:[25,41]})}).bindPopup("Driver").addTo(map);`:""}${location?`L.marker([${location.latitude},${location.longitude}],{icon:L.icon({iconUrl:"https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png",iconSize:[25,41]})}).bindPopup("You").addTo(map);`:""}</script></body></html>`}}/>
      <View style={{flexDirection:"row",gap:8,margin:8}}>
        <TouchableOpacity style={[s.btn,{flex:1,backgroundColor:"#1a3a1a",borderColor:"#4caf50",borderWidth:1}]} onPress={()=>fetchDriverLocation(activeBookingId)}>
          <Text style={[s.btnTxt,{color:"#4caf50",fontSize:13}]}>🔄 Refresh</Text>
        </TouchableOpacity>
        <TouchableOpacity style={[s.btn,{flex:1,backgroundColor:"#1a2a3a",borderColor:"#2196f3",borderWidth:1}]} onPress={async()=>{
          await supabase.from('bookings').update({status:"completed"}).eq('id',activeBookingId);
          Alert.alert("Ride Complete!","The ride has been marked as complete.");
          go("clientOrders");
        }}>
          <Text style={[s.btnTxt,{color:"#2196f3",fontSize:13}]}>✅ Complete</Text>
        </TouchableOpacity>
        <TouchableOpacity style={[s.btn,{flex:1,backgroundColor:"#3a1a1a",borderColor:"#f44336",borderWidth:1}]} onPress={()=>{setSosActive(true);Alert.alert("🚨 SOS","Emergency services have been alerted. Stay calm.");}}>
          <Text style={[s.btnTxt,{color:"#f44336",fontSize:13}]}>🚨 SOS</Text>
        </TouchableOpacity>
      </View>
      <ScrollView style={{flex:1,padding:12}} ref={r=>r?.scrollToEnd({animated:true})}>
        <Text style={{color:"#888",fontSize:12,textAlign:"center",marginBottom:8}}>Chat with your passenger</Text>
        {chatMessages.map((m,i)=>(
          <View key={i} style={{alignSelf:m.sender_id===user?.id?"flex-end":"flex-start",backgroundColor:m.sender_id===user?.id?"#2196f3":"#333",padding:10,borderRadius:12,marginBottom:6,maxWidth:"80%"}}>
            <Text style={{color:"#fff",fontSize:13}}>{m.message}</Text>
            <Text style={{color:"rgba(255,255,255,0.6)",fontSize:10}}>{m.sender_name}</Text>
          </View>
        ))}
      </ScrollView>
      <View style={{flexDirection:"row",padding:8,gap:8,backgroundColor:"#111"}}>
        <TextInput value={chatInput} onChangeText={setChatInput} placeholder="Type a message..." placeholderTextColor="#555" style={{flex:1,backgroundColor:"#1a1a1a",color:"#fff",borderRadius:20,paddingHorizontal:16,paddingVertical:8,borderWidth:1,borderColor:"#333"}}/>
        <TouchableOpacity onPress={()=>sendMessage(activeBookingId)} style={{backgroundColor:"#f5a623",borderRadius:20,paddingHorizontal:16,paddingVertical:8,justifyContent:"center"}}>
          <Text style={{color:"#000",fontWeight:"bold"}}>Send</Text>
        </TouchableOpacity>
      </View>
    </View>
  </SafeAreaView>
);
if(screen==="driverMap") return (
    <SafeAreaView style={s.safe}>
      <View style={s.nav}>
        <TouchableOpacity onPress={()=>go("driverHome")}><Text style={s.navLink}>Back</Text></TouchableOpacity>
        <Text style={s.navLogo}>Live Tracker</Text>
        <View/>
      </View>
      <ScrollView contentContainerStyle={{padding:16}}>
        
            <WebView key={`${location?.latitude||5.6}-${location?.longitude||0.2}`} style={{...s.map,height:280,borderRadius:12}} source={{html:`<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"/><script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script><style>html,body,#map{height:100%;margin:0}</style></head><body><div id="map"></div><script>var lat=${location?.latitude||6.6},lng=${location?.longitude||-1.6};var map=L.map("map").setView([lat,lng],15);L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png").addTo(map);L.marker([lat,lng]).addTo(map).bindPopup("Driver Here").openPopup();</script></body></html>`}}/>
        
        <TouchableOpacity style={s.btn} onPress={async()=>{
          const {status}=await Location.requestForegroundPermissionsAsync();
          if(status==="granted"){const l=await Location.getCurrentPositionAsync({});setLocation(l.coords);}
        }}><Text style={s.btnTxt}>Get My Location</Text></TouchableOpacity>
      </ScrollView>
    </SafeAreaView>
  );
  if(screen==="driverHome") return (
    <SafeAreaView style={s.safe}>
      <View style={s.nav}>
        <Text style={s.navLogo}>Lumina Links</Text>
        <TouchableOpacity onPress={logout}><Text style={s.navLink}>Log Out</Text></TouchableOpacity>
      </View>
      <ScrollView contentContainerStyle={{padding:20}}>
        <Text style={{color:"#fff",fontSize:18,fontWeight:"bold",marginBottom:4}}>Welcome, {user&&user.name}!</Text>
        <WebView key={`map-${location?.latitude||6.6}`} style={{width:"100%",height:220,borderRadius:12,marginBottom:12,overflow:"hidden"}} source={{html:`<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"/><script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script><style>html,body,#map{height:100%;margin:0}</style></head><body><div id="map"></div><script>var lat=${location?.latitude||6.6},lng=${location?.longitude||-1.6};var map=L.map("map").setView([lat,lng],15);L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png").addTo(map);L.marker([lat,lng]).addTo(map);</script></body></html>`}}/>
        <Text style={{color:"#888",fontSize:14,marginBottom:20}}>You are online as a driver</Text>
        <TouchableOpacity style={s.btn} onPress={()=>go("driverMap")}>
          <Text style={s.btnTxt}>📍 Live Tracker</Text>
        </TouchableOpacity>
        <TouchableOpacity style={[s.btn,{marginTop:12,backgroundColor:"#1a2a3a",borderWidth:1,borderColor:"#c9a84c"}]} onPress={()=>go("clientOrders")}>
          <Text style={[s.btnTxt,{color:"#c9a84c"}]}>📋 View Orders</Text>
        </TouchableOpacity>
        <TouchableOpacity style={[s.btn,{marginTop:8,backgroundColor:"#1a3a1a",borderWidth:1,borderColor:"#4caf50"}]} onPress={()=>go("driverEarnings")}>
          <Text style={[s.btnTxt,{color:"#4caf50"}]}>💰 My Earnings</Text>
        </TouchableOpacity>
      </ScrollView>
    </SafeAreaView>
  );
if(screen==="rateDriver") return (
  <SafeAreaView style={s.safe}>
    <View style={s.nav}>
      <Text style={s.navLogo}>Rate Your Driver</Text>
      <View/>
    </View>
    <View style={{flex:1,alignItems:"center",justifyContent:"center",padding:24}}>
      <Text style={{color:"#fff",fontSize:20,fontWeight:"bold",marginBottom:8}}>How was your ride?</Text>
      <Text style={{color:"#888",fontSize:14,marginBottom:32}}>Your feedback helps improve our service</Text>
      <View style={{flexDirection:"row",gap:12,marginBottom:32}}>
        {[1,2,3,4,5].map(star=>(
          <TouchableOpacity key={star} onPress={()=>setSelectedRating(star)}>
            <Text style={{fontSize:40}}>{star<=selectedRating?"⭐":"☆"}</Text>
          </TouchableOpacity>
        ))}
      </View>
      <TouchableOpacity style={[s.btn,{width:"100%"}]} onPress={async()=>{
        if(selectedRating===0){Alert.alert("Please select a rating");return;}
        await supabase.from('bookings').update({rating:selectedRating}).eq('id',ratingBookingId);
        Alert.alert("Thanks!","Your rating has been submitted.");
        go("clientHome");
      }}>
        <Text style={s.btnTxt}>Submit Rating</Text>
      </TouchableOpacity>
      <TouchableOpacity style={{marginTop:16}} onPress={()=>go("clientHome")}>
        <Text style={{color:"#555"}}>Skip</Text>
      </TouchableOpacity>
    </View>
  </SafeAreaView>
);
if(screen==="driverEarnings") return (
  <SafeAreaView style={s.safe}>
    <View style={s.nav}>
      <TouchableOpacity onPress={()=>go("driverHome")}><Text style={s.navLink}>← Back</Text></TouchableOpacity>
      <Text style={s.navLogo}>My Earnings</Text>
      <View/>
    </View>
    <ScrollView contentContainerStyle={{padding:20}}>
      <View style={{backgroundColor:"#1a3a1a",borderRadius:12,padding:20,marginBottom:16,alignItems:"center"}}>
        <Text style={{color:"#4caf50",fontSize:14,marginBottom:4}}>Total Earned</Text>
        <Text style={{color:"#4caf50",fontSize:36,fontWeight:"bold"}}>GHS {(driverBookings.filter(b=>b.status==="accepted").reduce((sum,b)=>sum+parseFloat(b.price||0),0)*0.90).toFixed(2)}</Text>
        <Text style={{color:"#888",fontSize:12,marginTop:4}}>{driverBookings.filter(b=>b.status==="accepted").length} completed rides</Text>
        <Text style={{color:"#555",fontSize:11,marginTop:2}}>After 10% LuminaLinks commission</Text>
        <Text style={{color:"#f5a623",fontSize:12,marginTop:4}}>Platform earned: GHS {(driverBookings.filter(b=>b.status==="accepted").reduce((sum,b)=>sum+parseFloat(b.price||0),0)*0.10).toFixed(2)}</Text>
      </View>
      <Text style={{color:"#fff",fontSize:16,fontWeight:"bold",marginBottom:12}}>Ride History</Text>
      {driverBookings.length===0?(
        <Text style={{color:"#888",textAlign:"center",marginTop:20}}>No rides yet. Accept your first order!</Text>
      ):(
        driverBookings.filter(b=>b.status==="accepted").map((b,i)=>(
          <View key={i} style={{backgroundColor:"#1a1a1a",borderRadius:12,padding:16,marginBottom:10,borderWidth:1,borderColor:"#333"}}>
            <View style={{flexDirection:"row",justifyContent:"space-between",marginBottom:6}}>
              <Text style={{color:"#fff",fontWeight:"bold"}}>🚗 Ride #{i+1}</Text>
              <Text style={{color:"#4caf50",fontWeight:"bold"}}>GHS {b.price}</Text>
            </View>
            <Text style={{color:"#888",fontSize:13}}>From: {b.pickup}</Text>
            <Text style={{color:"#888",fontSize:13}}>To: {b.dropoff}</Text>
            <Text style={{color:"#555",fontSize:12}}>Client: {b.client}</Text>
            <Text style={{color:"#555",fontSize:11,marginTop:4}}>{b.payment==="momo"?"📱 MoMo":b.payment==="card"?"💳 Card":"💵 Cash"} • {b.time}</Text>
          </View>
        ))
      )}
    </ScrollView>
  </SafeAreaView>
);
if(screen==="clientHome") return (
    <SafeAreaView style={s.safe}>
      <View style={s.nav}>
        <Text style={s.navLogo}>Lumina Links</Text>
        <TouchableOpacity onPress={logout}><Text style={s.navLink}>Log Out</Text></TouchableOpacity>
      </View>
      <ScrollView contentContainerStyle={{padding:20}}>
        <Text style={{color:"#888",fontSize:14}}>Welcome back,</Text>
        <WebView key={`map-${location?.latitude||6.6}`} style={{width:"100%",height:220,borderRadius:12,marginBottom:12,overflow:"hidden"}} source={{html:`<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"/><script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script><style>html,body,#map{height:100%;margin:0}</style></head><body><div id="map"></div><script>var lat=${location?.latitude||6.6},lng=${location?.longitude||-1.6};var map=L.map("map").setView([lat,lng],15);L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png").addTo(map);L.marker([lat,lng]).addTo(map);</script></body></html>`}}/>
        <Text style={s.title}>{user&&user.name?user.name:"Client"}</Text>
        <TouchableOpacity style={[s.btn,{marginTop:8}]} onPress={()=>go("bookRide")}>
          <Text style={s.btnTxt}>🚗 Book a Ride</Text>
        </TouchableOpacity>
        <TouchableOpacity style={s.btnBlue} onPress={()=>go("myBookings")}>
          <Text style={{color:"#2196f3",fontWeight:"bold",fontSize:15}}>My Bookings {clientBookings.length>0?"("+clientBookings.length+")":""}</Text>
        </TouchableOpacity>
        <Text style={[s.sectionTitle,{marginTop:24}]}>SERVICES</Text>
        {[["🚗","Rides","Book a driver"],["🛺","Tuk-tuk","Affordable trips"],["🏍️","Motorbike","Quick delivery"],["🧹","Cleaning","Home services"],["⚡","Electrical","Fix it fast"],["🔧","Plumbing","Leak repairs"]].map(([ic,title,sub])=>(
          <TouchableOpacity key={title} style={[s.card,{flexDirection:"row",alignItems:"center"}]} onPress={()=>title==="Rides"?go("bookRide"):Alert.alert("Coming Soon!",title+" launching soon!")}>
            <Text style={{fontSize:32,marginRight:16}}>{ic}</Text>
            <View><Text style={s.cardTitle}>{title}</Text><Text style={s.cardSub}>{sub}</Text></View>
            <Text style={{color:"#c9a84c",marginLeft:"auto"}}>→</Text>
          </TouchableOpacity>
        ))}
      </ScrollView>
    </SafeAreaView>
  );
  if(screen==="myBookings") return (
  <SafeAreaView style={s.safe}>
    <View style={s.nav}>
      <TouchableOpacity onPress={()=>go("clientHome")}><Text style={s.navLink}>← Back</Text></TouchableOpacity>
      <Text style={s.navLogo}>My Bookings</Text>
      <View/>
    </View>
    <ScrollView contentContainerStyle={{padding:20}}>
      <Text style={{color:"#fff",fontSize:18,fontWeight:"bold",marginBottom:16}}>Your Ride History</Text>
      {clientBookings.length===0?(
        <Text style={{color:"#888",textAlign:"center",marginTop:40}}>No bookings yet. Book your first ride!</Text>
      ):(
        clientBookings.map((b,i)=>(
          <View key={i} style={{backgroundColor:"#1a1a1a",borderRadius:12,padding:16,marginBottom:12,borderWidth:1,borderColor:"#333"}}>
            <View style={{flexDirection:"row",justifyContent:"space-between",marginBottom:8}}>
              <Text style={{color:"#fff",fontWeight:"bold",fontSize:15}}>🚗 Ride #{i+1}</Text>
              <Text style={{color:b.status==="accepted"?"#4caf50":"#f5a623",fontWeight:"bold",fontSize:12}}>{b.status?.toUpperCase()}</Text>
            </View>
            <Text style={{color:"#888",fontSize:13}}>📍 From: {b.pickup}</Text>
            <Text style={{color:"#888",fontSize:13}}>📍 To: {b.dropoff}</Text>
            <View style={{flexDirection:"row",justifyContent:"space-between",marginTop:8}}>
              <Text style={{color:"#c9a84c",fontWeight:"bold"}}>GHS {b.price}</Text>
              <Text style={{color:"#555",fontSize:12}}>{b.payment==="momo"?"📱 MoMo":b.payment==="card"?"💳 Card":"💵 Cash"}</Text>
            </View>
            <Text style={{color:"#444",fontSize:11,marginTop:4}}>{b.time}</Text>
          </View>
        ))
      )}
    </ScrollView>
  </SafeAreaView>
);
if(screen==="bookRide") return (
    <SafeAreaView style={s.safe}>
      <View style={s.nav}>
        <TouchableOpacity onPress={()=>go("clientHome")}><Text style={s.navLink}>Back</Text></TouchableOpacity>
        <Text style={s.navLogo}>Book a Ride</Text>
        <View/>
      </View>
      <ScrollView contentContainerStyle={{padding:16}} keyboardShouldPersistTaps="handled">
        <Text style={s.sectionTitle}>PICKUP LOCATION</Text>
        <TextInput style={s.input} placeholder="Search pickup address..." placeholderTextColor="#555" value={pickupText} onChangeText={pickupChange} onFocus={()=>setActiveField("pickup")}/>
        {activeField==="pickup"&&pickupSugg.length>0&&(
          <View style={s.suggestBox}>
            {pickupSugg.map((p,i)=>(
              <TouchableOpacity key={i} style={s.suggestItem} onPress={()=>selPickup(p)}>
                <Text style={s.suggestTxt}>📍 {p.name.length>60?p.name.substring(0,60)+"...":p.name}</Text>
              </TouchableOpacity>
            ))}
          </View>
        )}
        <Text style={s.sectionTitle}>DROPOFF LOCATION</Text>
        <TextInput style={s.input} placeholder="Search dropoff address..." placeholderTextColor="#555" value={dropoffText} onChangeText={dropoffChange} onFocus={()=>setActiveField("dropoff")}/>
        {activeField==="dropoff"&&dropoffSugg.length>0&&(
          <View style={s.suggestBox}>
            {dropoffSugg.map((p,i)=>(
              <TouchableOpacity key={i} style={s.suggestItem} onPress={()=>selDropoff(p)}>
                <Text style={s.suggestTxt}>🏁 {p.name.length>60?p.name.substring(0,60)+"...":p.name}</Text>
              </TouchableOpacity>
            ))}
          </View>
        )}
        {estFare&&(
          <View style={s.fareBox}>
            <Text style={{color:"#4caf50",fontWeight:"bold",fontSize:16,textAlign:"center"}}>Estimated Fare</Text>
            <Text style={{color:"#fff",fontSize:28,fontWeight:"bold",textAlign:"center",marginTop:4}}></Text>
            <Text style={{color:"#888",textAlign:"center"}}>~{estKm} km - Base .50 + .20/km</Text>
          </View>
        )}
        <Text style={s.sectionTitle}>OR PIN ON MAP</Text>
        <View style={s.pinRow}>
          <TouchableOpacity style={[s.pinBtn,{backgroundColor:pinMode==="pickup"?"#2196f3":"#1a2a3a",borderWidth:1,borderColor:"#2196f3"}]} onPress={()=>setPinMode(pinMode==="pickup"?null:"pickup")}>
            <Text style={{color:"#fff",fontWeight:"700"}}>{pinMode==="pickup"?"Tap map...":"Pin Pickup"}</Text>
          </TouchableOpacity>
          <TouchableOpacity style={[s.pinBtn,{backgroundColor:pinMode==="dropoff"?"#e91e63":"#2a1a1a",borderWidth:1,borderColor:"#e91e63"}]} onPress={()=>setPinMode(pinMode==="dropoff"?null:"dropoff")}>
            <Text style={{color:"#fff",fontWeight:"700"}}>{pinMode==="dropoff"?"Tap map...":"Pin Dropoff"}</Text>
          </TouchableOpacity>
        </View>
        <WebView style={{...s.map,height:250}} onMessage={(e)=>{try{const d=JSON.parse(e.nativeEvent.data);if(d.type==="pickup"){setPickupText(d.lat.toFixed(4)+", "+d.lng.toFixed(4));setPickupPin({latitude:d.lat,longitude:d.lng});}else{setDropoffText(d.lat.toFixed(4)+", "+d.lng.toFixed(4));setDropoffPin({latitude:d.lat,longitude:d.lng});}}catch(err){}}} source={{html:`<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"/><script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script><style>html,body,#map{height:100%;margin:0}</style></head><body><div id="map"></div><script>var map=L.map("map").setView([${location?.latitude||6.6},${location?.longitude||-1.6}],15);L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png").addTo(map);var pk=null,dk=null;var mode="pickup";map.on("click",function(e){if(mode==="pickup"){if(pk)map.removeLayer(pk);pk=L.marker(e.latlng,{icon:L.icon({iconUrl:"https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png",iconSize:[25,41]})}).addTo(map).bindPopup("Pickup").openPopup();window.ReactNativeWebView.postMessage(JSON.stringify({type:"pickup",lat:e.latlng.lat,lng:e.latlng.lng}));mode="dropoff";}else{if(dk)map.removeLayer(dk);dk=L.marker(e.latlng,{icon:L.icon({iconUrl:"https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png",iconSize:[25,41]})}).addTo(map).bindPopup("Dropoff").openPopup();window.ReactNativeWebView.postMessage(JSON.stringify({type:"dropoff",lat:e.latlng.lat,lng:e.latlng.lng}));mode="pickup";}});</script></body></html>`}}/>
        <View style={{marginTop:12}}>
          <Text style={{color:"#fff",fontWeight:"bold",marginBottom:8}}>Payment Method:</Text>
          <View style={{flexDirection:"row",gap:8,marginBottom:12}}>
            <TouchableOpacity onPress={()=>setPaymentMethod("cash")} style={{flex:1,padding:12,borderRadius:8,backgroundColor:paymentMethod==="cash"?"#f5a623":"#333",alignItems:"center"}}>
              <Text style={{color:"#fff",fontSize:18}}>💵</Text>
              <Text style={{color:"#fff",fontSize:12}}>Cash</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={()=>setPaymentMethod("momo")} style={{flex:1,padding:12,borderRadius:8,backgroundColor:paymentMethod==="momo"?"#f5a623":"#333",alignItems:"center"}}>
              <Text style={{color:"#fff",fontSize:18}}>📱</Text>
              <Text style={{color:"#fff",fontSize:12}}>Mobile Money</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={()=>setPaymentMethod("card")} style={{flex:1,padding:12,borderRadius:8,backgroundColor:paymentMethod==="card"?"#f5a623":"#333",alignItems:"center"}}>
              <Text style={{color:"#fff",fontSize:18}}>💳</Text>
              <Text style={{color:"#fff",fontSize:12}}>Card</Text>
            </TouchableOpacity>
          </View>
        </View>
        <TouchableOpacity style={[s.btn,{marginTop:8}]} onPress={submitRide}>
          <Text style={s.btnTxt}>Confirm Booking</Text>
        </TouchableOpacity>

      </ScrollView>
    </SafeAreaView>
  );

  return null;
}
