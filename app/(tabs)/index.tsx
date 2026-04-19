import { useState } from 'react';
import { View, Text, ScrollView, TouchableOpacity, TextInput, StyleSheet, SafeAreaView, StatusBar, Alert } from 'react-native';
import { supabase } from '../../lib/supabase';

const C = {
  bg: '#0d1b2a', card: '#132035', light: '#1a2d45',
  teal: '#00e5c8', green: '#4ade80', text: '#e8f0f8',
  muted: '#7a9ab5', red: '#f87171',
};

const SERVICES = [
  { id:1, icon:'🚗', label:'Book Rides',     desc:'Fast reliable transport',    price:'From $5',   eta:'3 min' },
  { id:2, icon:'🍽️', label:'Order Meals',    desc:'Tons of cuisines delivered', price:'From $2',   eta:'25 min' },
  { id:3, icon:'🛍️', label:'Shop Favorites', desc:'Top quality, same day',      price:'Free ship', eta:'Today' },
  { id:4, icon:'🔧', label:'Home Services',  desc:'Trusted home remedies',      price:'From $20',  eta:'Today' },
];

export default function App() {
  const [page, setPage] = useState('landing');
  const [signupStep, setSignupStep] = useState(0);
  const [acctType, setAcctType] = useState('');
  const [provType, setProvType] = useState('');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [otp, setOtp] = useState('');
  const [idDone, setIdDone] = useState(false);
  const [licDone, setLicDone] = useState(false);
  const [loading, setLoading] = useState(false);
  const [user, setUser] = useState(null);

  const go = (p: string) => { setPage(p); setSignupStep(0); setOtp(''); setIdDone(false); setLicDone(false); };

  const handleLogin = async () => {
    setLoading(true);
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    setLoading(false);
    if (error) { Alert.alert('Login Failed', error.message); return; }
    setUser(data.user);
    go('dashboard');
  };

  const handleSignup = async () => {
    setLoading(true);
    const { data, error } = await supabase.auth.signUp({ email, password });
    setLoading(false);
    if (error) { Alert.alert('Signup Failed', error.message); return; }
    if (data.user) {
      await supabase.from('profiles').insert({
        id: data.user.id,
        full_name: name,
        email: email,
        account_type: acctType,
        provider_type: provType,
      });
    }
    setSignupStep(signupStep + 1);
  };

  const handleProviderSignup = async () => {
    setLoading(true);
    const { data, error } = await supabase.auth.signUp({ email, password });
    setLoading(false);
    if (error) { Alert.alert('Signup Failed', error.message); return; }
    if (data.user) {
      await supabase.from('profiles').insert({
        id: data.user.id,
        full_name: name,
        email: email,
        account_type: 'provider',
        provider_type: provType,
        verified: false,
      });
    }
    setSignupStep(signupStep + 1);
  };

  if (page === 'landing') return (
    <SafeAreaView style={s.safe}>
      <StatusBar barStyle="light-content" backgroundColor={C.bg} />
      <ScrollView contentContainerStyle={s.center}>
        <Text style={s.logo}>✦ Lumina Links</Text>
        <Text style={s.tagline}>All-in-One Service Platform</Text>
        <Text style={s.hero}>Experience{'\n'}<Text style={s.heroTeal}>Lumina Links</Text></Text>
        <Text style={s.sub}>Rides, meals, shopping, home services — all in one platform.</Text>
        <TouchableOpacity style={s.btnTeal} onPress={() => go('signup')}>
          <Text style={s.btnTealTxt}>Get Started</Text>
        </TouchableOpacity>
        <TouchableOpacity style={s.btnGhost} onPress={() => go('login')}>
          <Text style={s.btnGhostTxt}>Log In</Text>
        </TouchableOpacity>
        <View style={s.grid}>
          {SERVICES.map(sv => (
            <TouchableOpacity key={sv.id} style={s.svcCard} onPress={() => go('signup')}>
              <Text style={s.svcIcon}>{sv.icon}</Text>
              <Text style={s.svcLabel}>{sv.label}</Text>
              <Text style={s.svcDesc}>{sv.desc}</Text>
            </TouchableOpacity>
          ))}
        </View>
        <View style={s.stats}>
          {[['12K+','Users'],['50K+','Orders'],['4.9★','Rating'],['98%','Happy']].map(([v,l]) => (
            <View key={l} style={s.stat}><Text style={s.statVal}>{v}</Text><Text style={s.statLbl}>{l}</Text></View>
          ))}
        </View>
        <TouchableOpacity onPress={() => go('admin')}><Text style={[s.muted,{marginTop:16}]}>Admin Portal →</Text></TouchableOpacity>
      </ScrollView>
    </SafeAreaView>
  );

  if (page === 'login') return (
    <SafeAreaView style={s.safe}>
      <ScrollView contentContainerStyle={s.authWrap}>
        <TouchableOpacity onPress={() => go('landing')}><Text style={s.back}>← Back</Text></TouchableOpacity>
        <Text style={s.logo}>✦ Lumina Links</Text>
        <Text style={s.authTitle}>Welcome back</Text>
        <Text style={s.authSub}>Log in to your account</Text>
        <TextInput style={s.input} placeholder="📧 Email" placeholderTextColor={C.muted} value={email} onChangeText={setEmail} keyboardType="email-address" autoCapitalize="none" />
        <TextInput style={s.input} placeholder="🔒 Password" placeholderTextColor={C.muted} value={password} onChangeText={setPassword} secureTextEntry />
        <TouchableOpacity style={[s.btnTeal, loading && {opacity:0.6}]} onPress={handleLogin} disabled={loading}>
          <Text style={s.btnTealTxt}>{loading ? 'Logging in...' : 'Log In'}</Text>
        </TouchableOpacity>
        <TouchableOpacity style={s.btnGhost} onPress={() => { setAcctType('provider'); go('provider'); }}>
          <Text style={s.btnGhostTxt}>Log In as Provider</Text>
        </TouchableOpacity>
        <TouchableOpacity onPress={() => go('signup')}><Text style={[s.muted,{textAlign:'center',marginTop:16}]}>No account? <Text style={{color:C.teal}}>Sign up</Text></Text></TouchableOpacity>
      </ScrollView>
    </SafeAreaView>
  );

  if (page === 'signup' && signupStep === 0) return (
    <SafeAreaView style={s.safe}>
      <ScrollView contentContainerStyle={s.authWrap}>
        <TouchableOpacity onPress={() => go('landing')}><Text style={s.back}>← Back</Text></TouchableOpacity>
        <Text style={s.logo}>✦ Lumina Links</Text>
        <Text style={s.authTitle}>Create account</Text>
        <Text style={s.authSub}>Who are you joining as?</Text>
        {[{type:'user',icon:'👤',title:'User',body:'Book rides, order food, shop & more'},
          {type:'provider',icon:'🛠️',title:'Service Provider',body:'Offer your services on the platform'}].map(opt => (
          <TouchableOpacity key={opt.type} style={[s.optCard, acctType===opt.type && s.optCardActive]}
            onPress={() => { setAcctType(opt.type); setSignupStep(1); }}>
            <Text style={s.optIcon}>{opt.icon}</Text>
            <View style={{flex:1}}>
              <Text style={s.optTitle}>{opt.title}</Text>
              <Text style={s.optBody}>{opt.body}</Text>
            </View>
            {acctType===opt.type && <Text style={{color:C.teal}}>✓</Text>}
          </TouchableOpacity>
        ))}
        <TouchableOpacity onPress={() => go('login')}><Text style={[s.muted,{textAlign:'center',marginTop:16}]}>Have an account? <Text style={{color:C.teal}}>Log in</Text></Text></TouchableOpacity>
      </ScrollView>
    </SafeAreaView>
  );

  if (page === 'signup' && acctType === 'user' && signupStep === 1) return (
    <SafeAreaView style={s.safe}>
      <ScrollView contentContainerStyle={s.authWrap}>
        <TouchableOpacity onPress={() => setSignupStep(0)}><Text style={s.back}>← Back</Text></TouchableOpacity>
        <Text style={s.stepBar}>● ○ ○  User Sign Up</Text>
        <Text style={s.authTitle}>Your details</Text>
        <TextInput style={s.input} placeholder="👤 Full Name" placeholderTextColor={C.muted} value={name} onChangeText={setName} />
        <TextInput style={s.input} placeholder="📧 Email" placeholderTextColor={C.muted} value={email} onChangeText={setEmail} keyboardType="email-address" autoCapitalize="none" />
        <TextInput style={s.input} placeholder="🔒 Password" placeholderTextColor={C.muted} value={password} onChangeText={setPassword} secureTextEntry />
        <TouchableOpacity style={[s.btnTeal, loading && {opacity:0.6}]} onPress={handleSignup} disabled={loading}>
          <Text style={s.btnTealTxt}>{loading ? 'Creating account...' : 'Continue →'}</Text>
        </TouchableOpacity>
      </ScrollView>
    </SafeAreaView>
  );

  if (page === 'signup' && acctType === 'user' && signupStep === 2) return (
    <SafeAreaView style={s.safe}>
      <ScrollView contentContainerStyle={s.authWrap}>
        <Text style={s.stepBar}>● ● ○  Email Verification</Text>
        <Text style={{fontSize:48,textAlign:'center',marginVertical:16}}>📧</Text>
        <Text style={s.authTitle}>Check your email!</Text>
        <Text style={[s.authSub,{textAlign:'center'}]}>We sent a verification link to{'\n'}<Text style={{color:C.teal,fontWeight:'bold'}}>{email}</Text>{'\n\n'}Click the link in your email to verify your account.</Text>
        <TouchableOpacity style={s.btnTeal} onPress={() => go('dashboard')}>
          <Text style={s.btnTealTxt}>Continue to Dashboard →</Text>
        </TouchableOpacity>
        <TouchableOpacity onPress={handleSignup}><Text style={[s.muted,{textAlign:'center',marginTop:12}]}>Didn't get it? <Text style={{color:C.teal}}>Resend</Text></Text></TouchableOpacity>
      </ScrollView>
    </SafeAreaView>
  );

  if (page === 'signup' && acctType === 'user' && signupStep >= 3) return (
    <SafeAreaView style={s.safe}>
      <View style={s.doneWrap}>
        <Text style={{fontSize:64}}>✅</Text>
        <Text style={s.authTitle}>You're all set!</Text>
        <Text style={[s.authSub,{textAlign:'center'}]}>Welcome to Lumina Links!</Text>
        <TouchableOpacity style={s.btnTeal} onPress={() => go('dashboard')}>
          <Text style={s.btnTealTxt}>Go to Dashboard →</Text>
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  );

  if (page === 'signup' && acctType === 'provider' && signupStep === 1) return (
    <SafeAreaView style={s.safe}>
      <ScrollView contentContainerStyle={s.authWrap}>
        <TouchableOpacity onPress={() => setSignupStep(0)}><Text style={s.back}>← Back</Text></TouchableOpacity>
        <Text style={s.stepBar}>● ○ ○ ○  Provider Sign Up</Text>
        <Text style={s.authTitle}>What service?</Text>
        {[{id:'driver',icon:'🚗',label:'Driver',desc:'Provide ride services'},
          {id:'food',icon:'🍽️',label:'Food Vendor',desc:'Sell & deliver meals'},
          {id:'shop',icon:'🛍️',label:'Shop Partner',desc:'List and sell products'},
          {id:'handyman',icon:'🔧',label:'Handyman',desc:'Home repair services'}].map(pt => (
          <TouchableOpacity key={pt.id} style={[s.optCard, provType===pt.id && s.optCardActive]} onPress={() => setProvType(pt.id)}>
            <Text style={s.optIcon}>{pt.icon}</Text>
            <View style={{flex:1}}>
              <Text style={s.optTitle}>{pt.label}</Text>
              <Text style={s.optBody}>{pt.desc}</Text>
            </View>
            {provType===pt.id && <Text style={{color:C.teal}}>✓</Text>}
          </TouchableOpacity>
        ))}
        <TouchableOpacity style={[s.btnTeal,!provType&&{opacity:0.4}]} onPress={() => provType && setSignupStep(2)}>
          <Text style={s.btnTealTxt}>Continue →</Text>
        </TouchableOpacity>
      </ScrollView>
    </SafeAreaView>
  );

  if (page === 'signup' && acctType === 'provider' && signupStep === 2) return (
    <SafeAreaView style={s.safe}>
      <ScrollView contentContainerStyle={s.authWrap}>
        <TouchableOpacity onPress={() => setSignupStep(1)}><Text style={s.back}>← Back</Text></TouchableOpacity>
        <Text style={s.stepBar}>● ● ○ ○  Account Details</Text>
        <Text style={s.authTitle}>Your details</Text>
        <TextInput style={s.input} placeholder="👤 Full Name" placeholderTextColor={C.muted} value={name} onChangeText={setName} />
        <TextInput style={s.input} placeholder="📧 Email" placeholderTextColor={C.muted} value={email} onChangeText={setEmail} keyboardType="email-address" autoCapitalize="none" />
        <TextInput style={s.input} placeholder="📱 Phone Number" placeholderTextColor={C.muted} keyboardType="phone-pad" />
        <TextInput style={s.input} placeholder="🔒 Password" placeholderTextColor={C.muted} value={password} onChangeText={setPassword} secureTextEntry />
        <TouchableOpacity style={[s.btnTeal, loading && {opacity:0.6}]} onPress={handleProviderSignup} disabled={loading}>
          <Text style={s.btnTealTxt}>{loading ? 'Creating account...' : 'Continue →'}</Text>
        </TouchableOpacity>
      </ScrollView>
    </SafeAreaView>
  );

  if (page === 'signup' && acctType === 'provider' && signupStep === 3) return (
    <SafeAreaView style={s.safe}>
      <ScrollView contentContainerStyle={s.authWrap}>
        <Text style={s.stepBar}>● ● ● ○  ID Verification</Text>
        <Text style={{fontSize:48,textAlign:'center',marginVertical:16}}>🪪</Text>
        <Text style={s.authTitle}>ID Verification</Text>
        <Text style={[s.authSub,{textAlign:'center',marginBottom:20}]}>Upload a government-issued ID.</Text>
        <TouchableOpacity style={[s.uploadBox, idDone && s.uploadDone]} onPress={() => setIdDone(!idDone)}>
          <Text style={{fontSize:32,marginBottom:8}}>{idDone?'✅':'📄'}</Text>
          <Text style={{color:idDone?C.teal:C.text,fontWeight:'bold'}}>{idDone?'Uploaded!':'Tap to upload ID'}</Text>
          <Text style={s.muted}>JPG, PNG or PDF</Text>
        </TouchableOpacity>
        <TouchableOpacity style={[s.btnTeal,!idDone&&{opacity:0.4}]} onPress={() => idDone && setSignupStep(provType==='driver'?4:5)}>
          <Text style={s.btnTealTxt}>{provType==='driver'?'Continue to Licence →':'Submit for Review →'}</Text>
        </TouchableOpacity>
      </ScrollView>
    </SafeAreaView>
  );

  if (page === 'signup' && acctType === 'provider' && signupStep === 4 && provType === 'driver') return (
    <SafeAreaView style={s.safe}>
      <ScrollView contentContainerStyle={s.authWrap}>
        <TouchableOpacity onPress={() => setSignupStep(3)}><Text style={s.back}>← Back</Text></TouchableOpacity>
        <Text style={s.stepBar}>● ● ● ● ●  Driver Licence</Text>
        <Text style={{fontSize:48,textAlign:'center',marginVertical:16}}>🚗</Text>
        <Text style={s.authTitle}>Driver's Licence</Text>
        <TouchableOpacity style={[s.uploadBox, licDone && s.uploadDone]} onPress={() => setLicDone(!licDone)}>
          <Text style={{fontSize:32,marginBottom:8}}>{licDone?'✅':'🪪'}</Text>
          <Text style={{color:licDone?C.teal:C.text,fontWeight:'bold'}}>{licDone?'Uploaded!':'Tap to upload Licence'}</Text>
          <Text style={s.muted}>Front & Back</Text>
        </TouchableOpacity>
        <TouchableOpacity style={[s.btnTeal,!licDone&&{opacity:0.4}]} onPress={() => licDone && setSignupStep(5)}>
          <Text style={s.btnTealTxt}>Submit for Review →</Text>
        </TouchableOpacity>
      </ScrollView>
    </SafeAreaView>
  );

  if (page === 'signup' && acctType === 'provider' && signupStep >= 5) return (
    <SafeAreaView style={s.safe}>
      <ScrollView contentContainerStyle={s.authWrap}>
        <Text style={{fontSize:64,textAlign:'center',marginVertical:16}}>⏳</Text>
        <Text style={s.authTitle}>Application Submitted!</Text>
        <Text style={[s.authSub,{textAlign:'center'}]}>Our team will verify your details within 24–48 hours. We'll notify you at <Text style={{color:C.teal}}>{email}</Text></Text>
        <View style={s.statusGrid}>
          {[['📧','Email','Verified',C.green],['🪪','ID','Under Review','#fb923c'],
            ...(provType==='driver'?[['🚗','Licence','Under Review','#fb923c']]:[])]
            .map(([ico,lbl,status,col]) => (
            <View key={String(lbl)} style={s.statusBox}>
              <Text style={{fontSize:24}}>{ico}</Text>
              <Text style={{color:C.text,fontWeight:'bold',fontSize:13,marginTop:4}}>{lbl}</Text>
              <Text style={{color:String(col),fontSize:11,fontWeight:'bold'}}>{status}</Text>
            </View>
          ))}
        </View>
        <TouchableOpacity style={s.btnGhost} onPress={() => go('landing')}>
          <Text style={s.btnGhostTxt}>Back to Home</Text>
        </TouchableOpacity>
      </ScrollView>
    </SafeAreaView>
  );

  if (page === 'dashboard') return (
    <SafeAreaView style={s.safe}>
      <View style={s.nav}>
        <Text style={s.navLogo}>✦ Lumina Links</Text>
        <View style={{flexDirection:'row',gap:8}}>
          <TouchableOpacity onPress={() => go('services')}><Text style={s.navLink}>Services</Text></TouchableOpacity>
          <TouchableOpacity onPress={() => go('admin')}><Text style={s.navLink}>Admin</Text></TouchableOpacity>
        </View>
      </View>
      <ScrollView contentContainerStyle={{padding:20}}>
        <Text style={[s.muted,{marginBottom:4}]}>Welcome back 👋</Text>
        <Text style={s.authTitle}>{name||'Alex Johnson'}</Text>
        <View style={s.wallet}>
          <View>
            <Text style={s.muted}>Lumina Wallet</Text>
            <Text style={s.walletAmt}>$124.50</Text>
            <Text style={s.muted}>2,480 reward points</Text>
          </View>
          <View style={{gap:8}}>
            <TouchableOpacity style={s.btnTealSm}><Text style={s.btnTealTxt}>Top Up</Text></TouchableOpacity>
            <TouchableOpacity style={s.btnGhostSm}><Text style={s.btnGhostTxt}>History</Text></TouchableOpacity>
          </View>
        </View>
        <Text style={s.sectionTitle}>Our Services</Text>
        <View style={s.grid}>
          {SERVICES.map(sv => (
            <TouchableOpacity key={sv.id} style={s.svcCardSm} onPress={() => go('services')}>
              <Text style={{fontSize:28}}>{sv.icon}</Text>
              <Text style={s.svcLabel}>{sv.label}</Text>
              <Text style={{color:C.teal,fontSize:12,fontWeight:'bold'}}>{sv.eta}</Text>
              <Text style={s.muted}>{sv.price}</Text>
            </TouchableOpacity>
          ))}
        </View>
        <Text style={s.sectionTitle}>Recent Orders</Text>
        {[{icon:'🚗',desc:'Downtown → Airport',status:'Completed',time:'2 hrs ago',amt:'$18.50'},
          {icon:'🍽️',desc:'Burger Palace',status:'Delivered',time:'Yesterday',amt:'$24.00'},
          {icon:'🔧',desc:'Plumbing Repair',status:'Scheduled',time:'Tomorrow',amt:'$65.00'}].map((o,i) => (
          <View key={i} style={s.orderRow}>
            <Text style={{fontSize:28,marginRight:12}}>{o.icon}</Text>
            <View style={{flex:1}}>
              <Text style={{color:C.text,fontWeight:'700'}}>{o.desc}</Text>
              <Text style={s.muted}>{o.time}</Text>
            </View>
            <View style={{alignItems:'flex-end'}}>
              <Text style={{color:C.teal,fontWeight:'800'}}>{o.amt}</Text>
              <Text style={s.tag}>{o.status}</Text>
            </View>
          </View>
        ))}
        <TouchableOpacity style={[s.btnGhost,{marginTop:20}]} onPress={async()=>{ await supabase.auth.signOut(); go('landing'); }}>
          <Text style={s.btnGhostTxt}>Sign Out</Text>
        </TouchableOpacity>
      </ScrollView>
    </SafeAreaView>
  );

  if (page === 'provider') return (
    <SafeAreaView style={s.safe}>
      <View style={s.nav}>
        <Text style={s.navLogo}>✦ Lumina Links</Text>
        <TouchableOpacity onPress={() => go('admin')}><Text style={s.navLink}>Admin</Text></TouchableOpacity>
      </View>
      <ScrollView contentContainerStyle={{padding:20}}>
        <Text style={s.muted}>Provider Portal</Text>
        <Text style={s.authTitle}>{name||'Sam Driver'}</Text>
        <View style={{flexDirection:'row',gap:12,marginBottom:20}}>
          {[["$84.50","Earnings","💰"],["6","Trips","📦"],["4.92 ⭐","Rating","🏆"]].map(([v,l,ic])=>(
            <View key={l} style={[s.statCard,{flex:1}]}>
              <Text style={{fontSize:24}}>{ic}</Text>
              <Text style={{col
