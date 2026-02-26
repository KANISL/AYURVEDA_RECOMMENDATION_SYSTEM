// apped.js - PeerJS Integration & 3D Scanning

// --- DATABASE SIMULATION ---
const DB = {
    getKey: (k) => JSON.parse(localStorage.getItem(k) || '[]'),
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
            user: null,
            authForm: { name: '', email: '', password: '', role: 'patient' },
            
            // Video (PeerJS)
            peer: null,
            myPeerId: null,
            currentCall: null,
            localStream: null,
            callStatus: 'idle', // idle, waiting, connected
            incomingCall: null,
            activeCall: null, // { doctorName, patientName }
            availableDoctors: [],
            
            // Rx & Records
            prescriptionDraft: '',
            lastReceivedRx: '',
            showSuggestions: false,
            herbSuggestions: [],
            myRecords: [],
            
            // 3D Engine Variables
            threeScene: null, 
            loadedOrgans: []
        }
    },
    mounted() {
        // Global Signal Listener
        window.addEventListener('storage', (e) => {
            if(!this.isLoggedIn) return;
            // Rx Sync
            if(e.key === 'ayur_live_rx' && this.user.role === 'patient') {
                let d = JSON.parse(e.newValue);
                if(d.pat === this.user.email) this.lastReceivedRx = d.txt;
            }
            // Signal Call (Fallback for PeerJS discovery)
            if(e.key === 'ayur_call_signal' && this.user.role === 'doctor') {
                let d = JSON.parse(e.newValue);
                if(d.docEmail === this.user.email && (Date.now() - d.ts < 5000)) {
                    console.log("Call Signal Received via Storage");
                }
            }
        });
    },
    methods: {
        // --- NAVIGATION & AUTH ---
        openExternal(url) {
            window.open(url, '_blank');
        },
        handleStartClick() {
            if(this.isLoggedIn) { this.currentPage = 'dashboard'; this.initPeer(); }
            else { this.showAuthModal = true; this.authMode = 'signup'; }
        },
        toggleAuthMode() { 
            this.authMode = this.authMode === 'signup' ? 'login' : 'signup'; 
        },
        
        // Google Login Placeholder
        handleGoogleLogin() {
            alert("Google Sign-In functionality will be implemented soon! For now, please use the Email & Password form.");
        },

        handleAuthSubmit() {
            if(this.authForm.role === 'doctor' && !this.authForm.name.startsWith('Dr.')) this.authForm.name = 'Dr. ' + this.authForm.name;
            if(this.authMode === 'signup') {
                if(DB.saveUser({...this.authForm})) this.loginSuccess(DB.login(this.authForm.email, this.authForm.password));
                else alert("Email taken");
            } else {
                let u = DB.login(this.authForm.email, this.authForm.password);
                if(u) this.loginSuccess(u); else alert("Invalid credentials");
            }
        },
        loginSuccess(u) {
            this.user = u; this.isLoggedIn = true; this.showAuthModal = false;
            this.currentPage = 'dashboard';
            this.currentTab = u.role === 'patient' ? 'find-doc' : 'consultation';
            this.loadData();
            this.initPeer(); // Start PeerJS immediately on login
        },
        logout() {
            if(this.peer) this.peer.destroy();
            this.isLoggedIn = false; location.reload(); 
        },
        loadData() {
            if(this.user.role === 'patient') this.availableDoctors = DB.getUsers().filter(u => u.role === 'doctor');
            this.myRecords = DB.getRecords(this.user.email, this.user.role);
        },
        switchTab(t) { 
            this.currentTab = t; 
            if(t === 'model') setTimeout(() => this.init3D(), 100);
            if(t === 'records') this.loadData();
        },

        // --- PEERJS VIDEO ENGINE ---
        sanitizeId(email) { return email.replace(/[^a-zA-Z0-9]/g, '').toLowerCase(); },
        
        initPeer() {
            if(this.peer) return;
            this.myPeerId = this.sanitizeId(this.user.email);
            this.peer = new Peer(this.myPeerId);
            
            this.peer.on('open', (id) => {
                console.log('My peer ID is: ' + id);
                if(this.user.role === 'doctor') {
                    navigator.mediaDevices.getUserMedia({video: true, audio: true}).then(stream => {
                        this.localStream = stream;
                        let vid = document.getElementById('preview-video');
                        if(vid) { vid.srcObject = stream; vid.muted = true; }
                    });
                }
            });

            this.peer.on('call', (call) => {
                this.incomingCall = { 
                    callObj: call, 
                    callerName: call.metadata?.callerName || 'Patient' 
                };
            });
        },

        startCall(doc) {
            this.activeCall = { doctorName: doc.name, patientName: this.user.name };
            this.currentTab = 'consultation-room';
            this.callStatus = 'waiting';
            
            navigator.mediaDevices.getUserMedia({video: true, audio: true}).then(stream => {
                this.localStream = stream;
                document.getElementById('local-video').srcObject = stream;
                
                const docId = this.sanitizeId(doc.email);
                const call = this.peer.call(docId, stream, { metadata: { callerName: this.user.name } });
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
            
            this.currentTab = 'consultation-room';
            this.activeCall = { doctorName: this.user.name, patientName: this.incomingCall.callerName };
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
            this.currentTab = this.user.role === 'patient' ? 'find-doc' : 'consultation';
            this.callStatus = 'idle';
            this.activeCall = null;
            if(this.user.role === 'doctor') setTimeout(() => this.initPeer(), 1000);
        },

        // --- RX & PRESCRIPTION ---
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
                doctorName: this.user.name, doctorEmail: this.user.email,
                patientName: this.activeCall?.patientName || 'Unknown', 
                patientEmail: this.activeCall ? this.sanitizeId(this.activeCall.patientName) : 'unknown', 
                prescription: this.prescriptionDraft
            });
            alert("Saved!");
        },

        // --- 3D ENGINE ---
        init3D() {
            let c = document.getElementById('three-canvas-container');
            if(!c || this.threeScene) return;

            // Basic Setup
            const scene = new THREE.Scene();
            // Moved camera back slightly to fit the taller layout
            const cam = new THREE.PerspectiveCamera(45, c.clientWidth/c.clientHeight, 0.1, 100);
            cam.position.set(0, 0, 15);
            const ren = new THREE.WebGLRenderer({alpha: true, antialias: true});
            ren.setSize(c.clientWidth, c.clientHeight);
            c.appendChild(ren.domElement);

            // Lighting
            scene.add(new THREE.AmbientLight(0xffffff, 1.5));
            const l = new THREE.DirectionalLight(0xffffff, 2); 
            l.position.set(5, 10, 10); 
            scene.add(l);
            
            const ctrls = new THREE.OrbitControls(cam, ren.domElement);
            ctrls.enableDamping = true;

            const loader = new THREE.GLTFLoader();
            this.loadedOrgans = []; // Clear array

            // Helper to automatically scale, center, and position models correctly
            const loadModel = (file, targetPos, scaleMultiplier) => {
                loader.load(file, (gltf) => {
                    const model = gltf.scene;
                    
                    const box = new THREE.Box3().setFromObject(model);
                    const center = box.getCenter(new THREE.Vector3());
                    const size = box.getSize(new THREE.Vector3());
                    
                    // Normalize the scale so different models match visually
                    const maxDim = Math.max(size.x, size.y, size.z);
                    const scale = (2 / maxDim) * scaleMultiplier; 
                    
                    model.scale.set(scale, scale, scale);
                    // Center the inner geometry then shift to the target anatomy layout
                    model.position.set(
                        (-center.x * scale) + targetPos[0], 
                        (-center.y * scale) + targetPos[1], 
                        (-center.z * scale) + targetPos[2]
                    );
                    
                    scene.add(model);
                    this.loadedOrgans.push(model);
                }, undefined, (error) => {
                    console.error("Error loading 3D Model:", file, error);
                });
            };

            // Loading models from the project directory and placing them anatomically
            loadModel('brain human.glb',           [ 0,    5.0,  0], 1.2);  // Top
            loadModel('3d-vh-m-larynx.glb',        [ 0,    3.0,  0], 0.8);  // Throat
            loadModel('heart.glb',                 [ 0,    1.0,  0], 1.0);  // Chest
            loadModel('3d-vh-m-pancreas (1).glb',  [ 0,   -0.5,  0], 0.9);  // Upper Abdomen
            loadModel('VH_M_Kidney_L.glb',         [-1.5, -1.5,  0], 0.8);  // Left Abdomen
            loadModel('VH_M_Kidney_R.glb',         [ 1.5, -1.5,  0], 0.8);  // Right Abdomen
            loadModel('VH_M_Ureter_R.glb',         [ 1.5, -3.0,  0], 0.6);  // Right Lower
            loadModel('SBU_M_Intestine_Large.glb', [ 0,   -3.5,  0], 1.3);  // Surrounding Lower Abdomen
            loadModel('VH_M_Small_Intestine.glb',  [ 0,   -3.5,  0], 1.1);  // Lower Abdomen Center

            const anim = () => { 
                requestAnimationFrame(anim); 
                ctrls.update();
                ren.render(scene, cam); 
            };
            anim();
            
            this.threeScene = scene;

            // Handle Resize Viewport
            window.addEventListener('resize', () => {
                if(c) {
                    cam.aspect = c.clientWidth / c.clientHeight;
                    cam.updateProjectionMatrix();
                    ren.setSize(c.clientWidth, c.clientHeight);
                }
            });
        },
        
        simulateDosha(d) {
             if(!this.loadedOrgans || this.loadedOrgans.length === 0) return;
             
             this.loadedOrgans.forEach(model => {
                 model.traverse((child) => {
                     // Find meshes that have a material color
                     if (child.isMesh && child.material && child.material.color) {
                         // Save original color
                         if (!child.userData.originalColor) {
                             child.userData.originalColor = child.material.color.clone();
                         }
                         
                         if (d === 'pitta') {
                             // Pitta represents Fire & Water - tint to fiery orange/red
                             child.material.color.setHex(0xff4500); 
                         } else if (d === 'reset') {
                             // Revert back to original textures/colors
                             child.material.color.copy(child.userData.originalColor);
                         }
                     }
                 });
             });
        }
    }
});
app.mount('#app');