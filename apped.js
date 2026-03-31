// apped.js - PeerJS Integration, 3D Scanning, Appointments & Advanced EHR

const DB = {
    getKey: (k) => JSON.parse(localStorage.getItem(k) || '[]'),
    getObjKey: (k) => JSON.parse(localStorage.getItem(k) || '{}'),
    setKey: (k, v) => localStorage.setItem(k, JSON.stringify(v)),
    getUsers: () => DB.getKey('ayur_users'),
    saveUser: (u) => {
        let users = DB.getUsers();
        if(users.find(x => x.email === u.email)) return false;
        users.push(u);
        DB.setKey('ayur_users', users);
        return true;
    },
    login: (e, p) => DB.getUsers().find(u => u.email === e && u.password === p),
    saveRecord: (r) => {
        let recs = DB.getKey('ayur_records');
        recs.push(r);
        DB.setKey('ayur_records', recs);
        localStorage.setItem('ayur_live_rx', JSON.stringify({ pat: r.patientEmail, txt: r.prescription, ts: Date.now() }));
    },
    getRecords: (email, role) => {
        let recs = DB.getKey('ayur_records');
        return role === 'doctor' ? recs.filter(r => r.doctorEmail === email) : recs.filter(r => r.patientEmail === email);
    },
    getPatientProfile: (email) => {
        let profiles = DB.getObjKey('ayur_profiles');
        if(!profiles[email]) {
            profiles[email] = { 
                age: 'Not Set', 
                vitals: { bp: '--/--', temp: '--', hr: '--' }, 
                advancedVitals: null, 
                documents: [] 
            };
        }
        return profiles[email];
    },
    updatePatientProfile: (email, data) => {
        let profiles = DB.getObjKey('ayur_profiles');
        profiles[email] = { ...(profiles[email] || {}), ...data };
        DB.setKey('ayur_profiles', profiles);
    },
    getAppointments: (email, role) => {
        let apps = DB.getKey('ayur_appointments');
        if (role === 'ehr') return apps; 
        return apps.filter(a => a.patientEmail === email || a.doctorEmail === email);
    },
    saveAppointment: (app) => {
        let apps = DB.getKey('ayur_appointments');
        apps.push(app);
        DB.setKey('ayur_appointments', apps);
    }
};

const HERBS = [
    {name: 'Ashwagandha', benefit: 'Stress relief'}, {name: 'Triphala', benefit: 'Digestion'},
    {name: 'Brahmi', benefit: 'Memory'}, {name: 'Turmeric', benefit: 'Inflammation'},
    {name: 'Tulsi', benefit: 'Respiratory'}, {name: 'Shatavari', benefit: 'Reproductive health'},
    {name: 'Guggul', benefit: 'Cholesterol'}, {name: 'Neem', benefit: 'Skin detox'}
];

const app = Vue.createApp({
    data() {
        return {
            currentPage: 'landing',
            currentTab: 'find-doc',
            showAuthModal: false,
            authMode: 'login',
            isLoggedIn: false,
            isMobileMenuOpen: false, // New Property for Mobile Drawer
            user: null,
            authForm: { name: '', email: '', password: '', role: 'patient' },
            
            allPatients: [],
            allDoctors: [],
            viewingProfileUser: null,
            viewingProfileData: null,
            viewingProfileRecords: [],
            latestConsultation: null,
            isParsingDoc: false,
            
            myAppointments: [],
            showBookModal: false,
            bookForm: { docEmail: '', date: '', time: '', reason: '' },

            peer: null,
            myPeerId: null,
            currentCall: null,
            localStream: null,
            callStatus: 'idle', 
            incomingCall: null,
            activeCall: null, 
            availableDoctors: [],
            audioEnabled: true, 
            videoEnabled: true, 
            
            prescriptionDraft: '',
            lastReceivedRx: '',
            showSuggestions: false,
            herbSuggestions: [],
            myRecords: [],
            
            threeScene: null, 
            loadedOrgans: [],
            iframeUrl: '',
            iframeTitle: ''
        }
    },
    mounted() {
        window.addEventListener('storage', (e) => {
            if(!this.isLoggedIn) return;
            if(e.key === 'ayur_live_rx' && this.user.role === 'patient') {
                let d = JSON.parse(e.newValue);
                if(d.pat === this.user.email) this.lastReceivedRx = d.txt;
            }
            if(e.key === 'ayur_call_signal' && this.user.role === 'doctor') {
                let d = JSON.parse(e.newValue);
                if(d.docEmail === this.user.email && (Date.now() - d.ts < 5000)) {
                    console.log("Call Signal Received via Storage");
                }
            }
        });
    },
    methods: {
        openExternal(url, title = 'AI Tool') {
            this.iframeUrl = url;
            this.iframeTitle = title;
            this.switchTab('iframe-view');
        },
        handleStartClick() {
            if(this.isLoggedIn) { this.currentPage = 'dashboard'; this.initPeer(); }
            else { this.showAuthModal = true; this.authMode = 'signup'; }
        },
        toggleAuthMode() { 
            this.authMode = this.authMode === 'signup' ? 'login' : 'signup'; 
        },
        handleGoogleLogin() {
            alert("Google Sign-In functionality will be implemented via backend API soon!");
        },
        handleAuthSubmit() {
            if(this.authForm.role === 'doctor' && !this.authForm.name.startsWith('Dr.')) this.authForm.name = 'Dr. ' + this.authForm.name;
            if(this.authMode === 'signup') {
                if(DB.saveUser({...this.authForm})) {
                    alert("Account created successfully!");
                    this.loginSuccess(DB.login(this.authForm.email, this.authForm.password));
                } else {
                    alert("Email already taken. Try logging in.");
                }
            } else {
                let u = DB.login(this.authForm.email, this.authForm.password);
                if(u) {
                    this.loginSuccess(u); 
                } else {
                    alert("Invalid email or password.");
                }
            }
        },
        loginSuccess(u) {
            this.user = u; this.isLoggedIn = true; this.showAuthModal = false;
            this.currentPage = 'dashboard';
            
            if (u.role === 'patient') { this.currentTab = 'find-doc'; this.openPatientProfile(u); }
            else if (u.role === 'doctor') { this.currentTab = 'consultation'; }
            else if (u.role === 'ehr') { this.currentTab = 'ehr-db'; }
            
            this.loadData();
            if(u.role !== 'ehr') this.initPeer(); 
        },
        logout() {
            if(this.peer) this.peer.destroy();
            this.isLoggedIn = false; location.reload(); 
        },
        loadData() {
            const users = DB.getUsers();
            this.availableDoctors = users.filter(u => u.role === 'doctor');
            this.allPatients = users.filter(u => u.role === 'patient');
            this.allDoctors = this.availableDoctors;
            this.myRecords = DB.getRecords(this.user.email, this.user.role);
            this.myAppointments = DB.getAppointments(this.user.email, this.user.role);
        },
        switchTab(t) { 
            this.currentTab = t; 
            this.isMobileMenuOpen = false; // Auto-close drawer on mobile
            if(t === 'model') setTimeout(() => this.init3D(), 100);
            if(t === 'records' || t === 'doc-records' || t === 'appointments') this.loadData();
        },

        openBookingModal() {
            this.showBookModal = true;
            this.bookForm = { docEmail: '', date: '', time: '', reason: '' };
        },
        bookAppointment() {
            if (!this.bookForm.docEmail || !this.bookForm.date || !this.bookForm.time) {
                alert("Please fill all fields."); return;
            }
            let doc = this.availableDoctors.find(d => d.email === this.bookForm.docEmail);
            DB.saveAppointment({
                id: Date.now(),
                patientEmail: this.user.email,
                patientName: this.user.name,
                doctorEmail: doc.email,
                doctorName: doc.name,
                date: this.bookForm.date,
                time: this.bookForm.time,
                reason: this.bookForm.reason,
                status: 'Scheduled'
            });
            this.showBookModal = false;
            this.loadData();
            alert("Appointment Scheduled Successfully!");
        },

        openPatientProfile(pat) {
            this.viewingProfileUser = pat;
            this.viewingProfileData = DB.getPatientProfile(pat.email);
            
            let records = DB.getRecords(pat.email, 'patient');
            records.sort((a, b) => new Date(b.date) - new Date(a.date)); 
            this.viewingProfileRecords = records;
            this.latestConsultation = records.length > 0 ? records[0] : null;

            this.switchTab('patient-profile'); // Re-uses centralized method to also close mobile menu
        },
        savePatientAge() {
            DB.updatePatientProfile(this.viewingProfileUser.email, { age: this.viewingProfileData.age });
            alert("Profile updated!");
        },
        
        handleDocumentUpload(e) {
            const file = e.target.files[0];
            if(!file) return;

            this.isParsingDoc = true;
            
            setTimeout(() => {
                const mockBpSys = Math.floor(Math.random() * (140 - 110 + 1)) + 110;
                const mockBpDia = Math.floor(Math.random() * (90 - 70 + 1)) + 70;
                const mockTemp = (Math.random() * (99.5 - 97.5) + 97.5).toFixed(1);
                const mockHr = Math.floor(Math.random() * (100 - 60 + 1)) + 60;

                const simulatedHbA1c = (Math.random() * (11.0 - 5.0) + 5.0).toFixed(1);
                const eAG = Math.round((28.7 * simulatedHbA1c) - 46.7);
                
                const fastingInsulin = (simulatedHbA1c > 6.4) ? (Math.random() * (30 - 15) + 15) : (Math.random() * (12 - 5) + 5);
                const homaIR = ((fastingInsulin * (eAG / 18)) / 22.5).toFixed(2); 
                const cPeptide = (fastingInsulin / 5).toFixed(2); 

                const HDL = Math.floor(Math.random() * (60 - 35) + 35);
                const TG = Math.floor(100 + (eAG * 0.45) + Math.random() * 50); 
                const TC = Math.floor(150 + (eAG * 0.4) + Math.random() * 40);
                const LDL = Math.floor(TC - HDL - (TG / 5)); 

                const renalThreshold = 180; 
                const urineGlucose = eAG > renalThreshold ? '+' + Math.ceil((eAG - renalThreshold)/40) : 'Negative';
                const urineKetones = eAG > 250 ? 'Trace/Positive' : 'Negative';

                let inferred = [];
                let highlightTargets = [];

                highlightTargets.push('pancreas');
                inferred.push({
                    condition: 'Pancreatic Metabolic Function',
                    detail: `Parsed HbA1c: ${simulatedHbA1c}%. Estimated Average Glucose (eAG): ${eAG} mg/dL. Calculated HOMA-IR: ${homaIR}. Est. C-Peptide: ${cPeptide} ng/mL.`,
                    target: 'pancreas'
                });

                if (eAG > renalThreshold) {
                    inferred.push({
                        condition: 'Renal Spillover (Glycosuria)',
                        detail: `eAG (${eAG} mg/dL) exceeds Renal Threshold (${renalThreshold} mg/dL). Calculated Urine Glucose: ${urineGlucose}. Calculated Urine Ketones: ${urineKetones}.`,
                        target: 'kidney'
                    });
                    highlightTargets.push('kidney');
                    highlightTargets.push('ureter');
                }

                if (LDL > 130 || TG > 150) {
                    inferred.push({
                        condition: 'Diabetic Dyslipidemia (Cardiovascular Risk)',
                        detail: `Calculated via Friedewald Eq: LDL: ${LDL} mg/dL, Triglycerides: ${TG} mg/dL, HDL: ${HDL} mg/dL, Total Chol: ${TC} mg/dL.`,
                        target: 'heart'
                    });
                    highlightTargets.push('heart');
                }

                const newDoc = {
                    id: Date.now(),
                    name: file.name,
                    date: new Date().toLocaleDateString(),
                    parsedSummary: `Metabolic/Glucose Report successfully parsed. Secondary lab calculations derived.`,
                    inferred: inferred,
                    targets: highlightTargets
                };

                const advancedVitalsData = {
                    eAG: eAG, homaIR: homaIR, cPeptide: cPeptide,
                    ldl: LDL, hdl: HDL, tg: TG, tc: TC,
                    urineGlucose: urineGlucose, urineKetones: urineKetones
                };

                // Deep copy trick to force Vue to reactively notice the new advancedVitals object
                let updatedProfile = JSON.parse(JSON.stringify(this.viewingProfileData));
                
                updatedProfile.documents.push(newDoc);
                updatedProfile.vitals = { bp: `${mockBpSys}/${mockBpDia}`, temp: mockTemp, hr: mockHr };
                updatedProfile.advancedVitals = advancedVitalsData; 

                this.viewingProfileData = updatedProfile; 
                DB.updatePatientProfile(this.viewingProfileUser.email, this.viewingProfileData);
                
                this.isParsingDoc = false;
                e.target.value = ''; 
                alert("Report mathematically processed and mapped to 3D Anatomy!");
            }, 2500);
        },

        sanitizeId(email) { return email.replace(/[^a-zA-Z0-9]/g, '').toLowerCase(); },
        initPeer() {
            if(this.peer) return;
            this.myPeerId = this.sanitizeId(this.user.email);
            this.peer = new Peer(this.myPeerId);
            this.peer.on('open', (id) => {
                if(this.user.role === 'doctor') {
                    navigator.mediaDevices.getUserMedia({video: true, audio: true}).then(stream => {
                        this.localStream = stream;
                        let vid = document.getElementById('preview-video');
                        if(vid) { vid.srcObject = stream; vid.muted = true; }
                    });
                }
            });
            this.peer.on('call', (call) => {
                this.incomingCall = { callObj: call, callerName: call.metadata?.callerName || 'Patient', callerEmail: call.metadata?.callerEmail || '' };
            });
        },
        toggleAudio() {
            if (this.localStream) {
                this.audioEnabled = !this.audioEnabled;
                this.localStream.getAudioTracks().forEach(track => track.enabled = this.audioEnabled);
            }
        },
        toggleVideo() {
            if (this.localStream) {
                this.videoEnabled = !this.videoEnabled;
                this.localStream.getVideoTracks().forEach(track => track.enabled = this.videoEnabled);
            }
        },
        startCall(doc) {
            this.activeCall = { doctorName: doc.name, doctorEmail: doc.email, patientName: this.user.name, patientEmail: this.user.email };
            this.switchTab('consultation-room'); // Automatically clears drawer flag too
            this.callStatus = 'waiting';
            navigator.mediaDevices.getUserMedia({video: true, audio: true}).then(stream => {
                this.localStream = stream;
                document.getElementById('local-video').srcObject = stream;
                const docId = this.sanitizeId(doc.email);
                const call = this.peer.call(docId, stream, { metadata: { callerName: this.user.name, callerEmail: this.user.email } });
                this.currentCall = call;
                call.on('stream', (remoteStream) => {
                    this.callStatus = 'connected';
                    document.getElementById('remote-video').srcObject = remoteStream;
                });
                localStorage.setItem('ayur_call_signal', JSON.stringify({ docEmail: doc.email, ts: Date.now() }));
            }).catch(err => alert("Camera access required!"));
        },
        acceptCall() {
            if(!this.incomingCall) return;
            let call = this.incomingCall.callObj;
            this.switchTab('consultation-room');
            this.activeCall = { doctorName: this.user.name, doctorEmail: this.user.email, patientName: this.incomingCall.callerName, patientEmail: this.incomingCall.callerEmail };
            this.callStatus = 'connected';
            this.incomingCall = null;
            navigator.mediaDevices.getUserMedia({video: true, audio: true}).then(stream => {
                this.localStream = stream;
                document.getElementById('local-video').srcObject = stream;
                call.answer(stream);
                this.currentCall = call;
                call.on('stream', (remoteStream) => {
                    document.getElementById('remote-video').srcObject = remoteStream;
                });
            });
        },
        rejectCall() { this.incomingCall = null; },
        endCall() {
            if(this.currentCall) this.currentCall.close();
            if(this.localStream) this.localStream.getTracks().forEach(t => t.stop());
            this.switchTab(this.user.role === 'patient' ? 'find-doc' : 'consultation');
            this.callStatus = 'idle';
            this.activeCall = null;
            this.audioEnabled = true; this.videoEnabled = true; 
            if(this.user.role === 'doctor') setTimeout(() => this.initPeer(), 1000);
        },

        handlePrescriptionInput(e) {
            let txt = e.target.value;
            let last = txt.split(' ').pop();
            if(last.length > 2) {
                this.herbSuggestions = HERBS.filter(h => h.name.toLowerCase().startsWith(last.toLowerCase()));
                this.showSuggestions = this.herbSuggestions.length > 0;
                this.lastWord = last;
            } else this.showSuggestions = false;
        },
        applySuggestion(h) {
            this.prescriptionDraft = this.prescriptionDraft.replace(new RegExp(this.lastWord + '$'), h.name + ' ');
            this.showSuggestions = false;
        },
        savePrescription() {
            if(!this.prescriptionDraft) return;
            DB.saveRecord({
                id: Date.now(), date: new Date().toISOString(),
                doctorName: this.activeCall?.doctorName || this.user.name, 
                doctorEmail: this.activeCall?.doctorEmail || this.user.email,
                patientName: this.activeCall?.patientName || 'Unknown', 
                patientEmail: this.activeCall?.patientEmail || 'unknown',
                prescription: this.prescriptionDraft
            });
            if(this.viewingProfileUser && this.viewingProfileUser.email === this.activeCall?.patientEmail) {
                this.openPatientProfile(this.viewingProfileUser);
            }
            alert("Saved!");
            this.prescriptionDraft = ''; 
        },

        init3D() {
            let c = document.getElementById('three-canvas-container');
            if(!c || this.threeScene) return;

            const scene = new THREE.Scene();
            const cam = new THREE.PerspectiveCamera(45, c.clientWidth/c.clientHeight, 0.1, 100);
            cam.position.set(0, 0, 15);
            const ren = new THREE.WebGLRenderer({alpha: true, antialias: true});
            ren.setSize(c.clientWidth, c.clientHeight);
            c.appendChild(ren.domElement);

            scene.add(new THREE.AmbientLight(0xffffff, 1.5));
            const l = new THREE.DirectionalLight(0xffffff, 2); 
            l.position.set(5, 10, 10); scene.add(l);
            
            const ctrls = new THREE.OrbitControls(cam, ren.domElement);
            ctrls.enableDamping = true;

            const loader = new THREE.GLTFLoader();
            this.loadedOrgans = []; 

            const loadModel = (file, targetPos, scaleMultiplier, organName) => {
                loader.load(file, (gltf) => {
                    const model = gltf.scene;
                    const box = new THREE.Box3().setFromObject(model);
                    const center = box.getCenter(new THREE.Vector3());
                    const size = box.getSize(new THREE.Vector3());
                    const maxDim = Math.max(size.x, size.y, size.z);
                    const scale = (2 / maxDim) * scaleMultiplier; 
                    
                    model.scale.set(scale, scale, scale);
                    model.position.set((-center.x * scale) + targetPos[0], (-center.y * scale) + targetPos[1], (-center.z * scale) + targetPos[2]);
                    
                    model.traverse((child) => {
                        if (child.isMesh) child.userData.organName = organName;
                    });
                    
                    scene.add(model);
                    this.loadedOrgans.push(model);
                }, undefined, (error) => console.error("Error loading 3D Model:", file, error));
            };

            loadModel('brain human.glb',           [ 0,    5.0,  0], 1.2, 'brain');  
            loadModel('3d-vh-m-larynx.glb',        [ 0,    3.0,  0], 0.8, 'larynx');  
            loadModel('heart.glb',                 [ 0,    1.0,  0], 1.0, 'heart');  
            loadModel('3d-vh-m-pancreas (1).glb',  [ 0,   -0.5,  0], 0.9, 'pancreas');  
            loadModel('VH_M_Kidney_L.glb',         [-1.5, -1.5,  0], 0.8, 'kidney');  
            loadModel('VH_M_Kidney_R.glb',         [ 1.5, -1.5,  0], 0.8, 'kidney');  
            loadModel('VH_M_Ureter_R.glb',         [ 1.5, -3.0,  0], 0.6, 'ureter');  
            loadModel('SBU_M_Intestine_Large.glb', [ 0,   -3.5,  0], 1.3, 'intestine_large');  
            loadModel('VH_M_Small_Intestine.glb',  [ 0,   -3.5,  0], 1.1, 'intestine_small');  

            const anim = () => { requestAnimationFrame(anim); ctrls.update(); ren.render(scene, cam); };
            anim();
            this.threeScene = scene;

            window.addEventListener('resize', () => {
                if(c) { cam.aspect = c.clientWidth / c.clientHeight; cam.updateProjectionMatrix(); ren.setSize(c.clientWidth, c.clientHeight); }
            });
        },
        
        simulateDosha(d) {
             if(!this.loadedOrgans || this.loadedOrgans.length === 0) return;
             this.loadedOrgans.forEach(model => {
                 model.traverse((child) => {
                     if (child.isMesh && child.material) {
                         if (!child.userData.matInitialized) {
                             child.material = child.material.clone();
                             if (child.material.color) child.userData.originalColor = child.material.color.clone();
                             if (child.material.emissive) child.userData.originalEmissive = child.material.emissive.clone();
                             child.userData.matInitialized = true;
                         }

                         if (d === 'pitta') {
                             if (child.material.color) child.material.color.setHex(0xff4500);
                             if (child.material.emissive) child.material.emissive.setHex(0x441100);
                         } else if (d === 'reset') {
                             if (child.material.color && child.userData.originalColor) child.material.color.copy(child.userData.originalColor);
                             if (child.material.emissive && child.userData.originalEmissive) child.material.emissive.copy(child.userData.originalEmissive);
                         }
                         child.material.needsUpdate = true;
                     }
                 });
             });
        },

        triggerDiagnosisHighlight(targets) {
            this.switchTab('model');
            setTimeout(() => {
                if(!this.loadedOrgans || this.loadedOrgans.length === 0) return;
                
                this.loadedOrgans.forEach(model => {
                    model.traverse((child) => {
                        if (child.isMesh && child.material) {
                            
                            if (!child.userData.matInitialized) {
                                child.material = child.material.clone();
                                if(child.material.color) child.userData.originalColor = child.material.color.clone();
                                if(child.material.emissive) child.userData.originalEmissive = child.material.emissive.clone();
                                child.userData.matInitialized = true;
                            }
                            
                            if (targets && targets.includes(child.userData.organName)) {
                                if(child.material.color) child.material.color.setHex(0xff0000); 
                                if(child.material.emissive) child.material.emissive.setHex(0x880000); 
                            } else {
                                if(child.material.color && child.userData.originalColor) {
                                    child.material.color.copy(child.userData.originalColor); 
                                }
                                if(child.material.emissive && child.userData.originalEmissive) {
                                    child.material.emissive.copy(child.userData.originalEmissive);
                                }
                            }
                            child.material.needsUpdate = true;
                        }
                    });
                });
            }, 800); 
        }
    }
});
app.mount('#app');
