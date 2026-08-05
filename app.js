let evStations = [
    { id: "ev_001", name: "MegaBox (Tesla)", address: "九龍灣宏照道38號", lat: 22.3197, lng: 114.2081, status: "online", fast: { total: 6, available: 2 }, medium: { total: 10, available: 4 } },
    { id: "ev_002", name: "E-Max (中電)", address: "九龍灣展貿徑1號", lat: 22.3242, lng: 114.2045, status: "online", fast: { total: 3, available: 0 }, medium: { total: 8, available: 1 } },
    { id: "ev_003", name: "德福廣場一期", address: "九龍灣偉業街33號", lat: 22.3218, lng: 114.2133, status: "online", fast: { total: 2, available: 1 }, medium: { total: 0, available: 0 } }
];

let parkingStations = [];
let cachedData = [];
let lastPosition = null;
let map = null;
let userMarker = null;
let mapMarkersMap = new Map();
let lineDistanceMarker = null;
let currentRadius = 5.0; 
let selectedParkId = null;
let autoRefreshTimer = null;

const BASIC_URL = "https://resource.data.one.gov.hk/td/carpark/basic_info_all.json";
const VACANCY_URL = "https://resource.data.one.gov.hk/td/carpark/vacancy_all.json";

document.addEventListener('DOMContentLoaded', () => {
    initPivot();
    initMap();
    initRadiusSlider();
    startAppProcess();
    initAutoRefresh();
});

function initPivot() {
    const headers = document.querySelectorAll('.pivot-header');
    headers.forEach(header => {
        header.addEventListener('click', () => {
            navigateTo(header.getAttribute('data-target'));
        });
    });
}

function navigateTo(targetId) {
    document.querySelectorAll('.pivot-header').forEach(h => {
        if(h.getAttribute('data-target') === targetId) {
            h.classList.add('active');
            h.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
        } else {
            h.classList.remove('active');
        }
    });
    document.querySelectorAll('.pivot-content').forEach(c => {
        c.classList.remove('active');
        if(c.id === targetId) c.classList.add('active');
    });

    if (targetId === 'nearby' && map) {
        setTimeout(() => map.resize(), 100);
    }
}

function initMap() {
    map = new maplibregl.Map({
        container: 'map',
        style: 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json',
        center: [114.2140, 22.3235],
        zoom: 13,
        attributionControl: false
    });
}

function centerUserLocation() {
    if (lastPosition && map) {
        map.flyTo({
            center: [lastPosition.coords.longitude, lastPosition.coords.latitude],
            zoom: 14,
            speed: 1.2
        });
    }
}

function initRadiusSlider() {
    const slider = document.getElementById('radius-slider');
    const valDisplay = document.getElementById('radius-val');

    slider.addEventListener('input', (e) => {
        currentRadius = parseFloat(e.target.value);
        valDisplay.innerText = formatDistanceDisplay(currentRadius);
        updateRadiusCircleOnMap();
        renderNearbyPage();
    });
}

function createCircleGeoJSON(centerLng, centerLat, radiusKm, points = 64) {
    const coords = [];
    const distanceX = radiusKm / (111.320 * Math.cos(centerLat * Math.PI / 180));
    const distanceY = radiusKm / 110.574;
    for (let i = 0; i < points; i++) {
        const theta = (i / points) * (2 * Math.PI);
        const x = distanceX * Math.cos(theta);
        const y = distanceY * Math.sin(theta);
        coords.push([centerLng + x, centerLat + y]);
    }
    coords.push(coords[0]);
    return {
        'type': 'Feature',
        'geometry': {
            'type': 'Polygon',
            'coordinates': [coords]
        }
    };
}

function updateRadiusCircleOnMap() {
    if (!map || !lastPosition) return;
    const uLng = lastPosition.coords.longitude;
    const uLat = lastPosition.coords.latitude;
    const circleGeoJSON = createCircleGeoJSON(uLng, uLat, currentRadius);

    if (map.getSource('radius-circle-source')) {
        map.getSource('radius-circle-source').setData(circleGeoJSON);
    } else {
        map.addSource('radius-circle-source', {
            'type': 'geojson',
            'data': circleGeoJSON
        });
        map.addLayer({
            'id': 'radius-circle-fill',
            'type': 'fill',
            'source': 'radius-circle-source',
            'paint': {
                'fill-color': '#fa6800',
                'fill-opacity': 0.08
            }
        });
        map.addLayer({
            'id': 'radius-circle-line',
            'type': 'line',
            'source': 'radius-circle-source',
            'paint': {
                'line-color': '#fa6800',
                'line-width': 1.5,
                'line-dasharray': [2, 2]
            }
        });
    }
}

function initAutoRefresh() {
    startAutoRefresh();
    document.addEventListener('visibilitychange', () => {
        if (document.hidden) {
            stopAutoRefresh();
        } else {
            refreshDataImmediately();
            startAutoRefresh();
        }
    });
}

function startAutoRefresh() {
    stopAutoRefresh();
    autoRefreshTimer = setInterval(() => {
        if (!document.hidden) {
            refreshDataImmediately();
        }
    }, 10000);
}

function stopAutoRefresh() {
    if (autoRefreshTimer) {
        clearInterval(autoRefreshTimer);
        autoRefreshTimer = null;
    }
}

async function refreshDataImmediately() {
    try {
        const [basicResponse, vacancyResponse] = await Promise.all([
            fetch(BASIC_URL, { cache: "no-store" }),
            fetch(VACANCY_URL, { cache: "no-store" })
        ]);

        if (!basicResponse.ok || !vacancyResponse.ok) return;

        const [basicData, vacancyData] = await Promise.all([basicResponse.json(), vacancyResponse.json()]);
        cachedData = normalizeGovernmentData(basicData, vacancyData);

        if (lastPosition) {
            processDataWithLocation(lastPosition.coords.latitude, lastPosition.coords.longitude);
        } else {
            parkingStations = cachedData;
            renderParkingStations();
            renderNearbyPage();
        }
    } catch (e) {
        console.error(e);
    }
}

function distanceKm(lat1, lon1, lat2, lon2) {
    const toRad = value => value * Math.PI / 180;
    const earthRadiusKm = 6371;
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
    return 2 * earthRadiusKm * Math.asin(Math.sqrt(a));
}

function formatDistanceDisplay(distKm) {
    if (distKm < 1) {
        return Math.round(distKm * 1000) + " 米";
    } else {
        return distKm.toFixed(1) + " 公里";
    }
}

function findPrivateCarVacancy(carPark) {
    const vehicle = (carPark?.vehicle_type || []).find(item => item.type === "P");
    if (!vehicle) return null;
    return (vehicle.service_category || []).find(item => item.category === "HOURLY") || vehicle.service_category?.[0] || null;
}

function formatVacancy(vacancyType, vacancy) {
    const numericVacancy = Number(vacancy);
    if (vacancyType === "C") return { text: "關閉", cssClass: "full" };
    if (vacancy === null || vacancy === undefined || numericVacancy === -1) return { text: "--", cssClass: "unknown" };
    if (vacancyType === "A") return { text: numericVacancy === 0 ? "0" : numericVacancy, cssClass: numericVacancy === 0 ? "full" : "available" };
    if (vacancyType === "B") return { text: numericVacancy === 0 ? "0" : "有", cssClass: numericVacancy === 0 ? "full" : "available" };
    return { text: "--", cssClass: "unknown" };
}

function normalizeGovernmentData(basicData, vacancyData) {
    const vacancyMap = new Map((vacancyData.car_park || []).map(item => [item.park_id, item]));
    return (basicData.car_park || []).map(info => {
        const vacancyRecord = vacancyMap.get(info.park_id);
        const vacancy = findPrivateCarVacancy(vacancyRecord);
        return {
            id: String(info.park_id).trim(),
            name: info.name_tc || info.name_en || "未命名停車場",
            address: info.displayAddress_tc || info.displayaddress_tc || info.displayAddress_en || info.displayaddress_en || "地址未提供",
            latitude: Number(info.latitude),
            longitude: Number(info.longitude),
            vacancy: vacancy?.vacancy ?? null,
            vacancyType: vacancy?.vacancy_type || "A"
        };
    }).filter(item => Number.isFinite(item.latitude) && Number.isFinite(item.longitude));
}

function getPosition() {
    return new Promise((resolve, reject) => {
        if (!navigator.geolocation) {
            reject(new Error("不支援定位"));
            return;
        }
        navigator.geolocation.getCurrentPosition(resolve, reject, {
            enableHighAccuracy: true, timeout: 12000, maximumAge: 60000
        });
    });
}

async function startAppProcess() {
    updateStatusText("正在取得位置及停車場資料...");
    try {
        const [position, basicResponse, vacancyResponse] = await Promise.all([
            getPosition().catch(() => null),
            fetch(BASIC_URL, { cache: "no-store" }),
            fetch(VACANCY_URL, { cache: "no-store" })
        ]);

        if (!basicResponse.ok || !vacancyResponse.ok) throw new Error("API 下載失敗");

        const [basicData, vacancyData] = await Promise.all([basicResponse.json(), vacancyResponse.json()]);
        cachedData = normalizeGovernmentData(basicData, vacancyData);

        document.getElementById('dash-api-status').innerText = "正常";
        document.getElementById('dash-api-status').style.color = "#ffffff";

        lastPosition = position;
        
        if (lastPosition) {
            const uLat = lastPosition.coords.latitude;
            const uLng = lastPosition.coords.longitude;
            
            if (map) {
                map.setCenter([uLng, uLat]);
                if (userMarker) userMarker.remove();
                const el = document.createElement('div');
                el.className = 'user-marker';
                userMarker = new maplibregl.Marker({ element: el }).setLngLat([uLng, uLat]).addTo(map);
                updateRadiusCircleOnMap();
            }

            processDataWithLocation(uLat, uLng);
            updateStatusText("已定位，顯示附近資料");
        } else {
            parkingStations = cachedData;
            renderParkingStations();
            renderNearbyPage();
            updateStatusText("未授權定位");
        }

    } catch (error) {
        console.error(error);
        document.getElementById('dash-api-status').innerText = "連線失敗";
        updateStatusText("API 錯誤");
    }
}

function processDataWithLocation(userLat, userLon) {
    parkingStations = cachedData.map(item => {
        const dist = distanceKm(userLat, userLon, item.latitude, item.longitude);
        return { ...item, rawDistance: dist, distanceDisplay: formatDistanceDisplay(dist) };
    }).sort((a, b) => a.rawDistance - b.rawDistance);

    evStations.forEach(station => {
        station.rawDistance = distanceKm(userLat, userLon, station.lat, station.lng);
        station.distanceDisplay = formatDistanceDisplay(station.rawDistance);
    });
    evStations.sort((a, b) => a.rawDistance - b.rawDistance);

    renderNearbyPage();
    renderParkingStations();
    renderEvStations();
    updateDashboard();

    if (selectedParkId) {
        const selectedPark = parkingStations.find(p => p.id === selectedParkId);
        if (selectedPark) updateConnectingLine(selectedPark);
    }
}

function updateConnectingLine(park) {
    if (!map || !lastPosition) return;
    const uLng = lastPosition.coords.longitude;
    const uLat = lastPosition.coords.latitude;
    const pLng = park.longitude;
    const pLat = park.latitude;

    const lineGeoJSON = {
        'type': 'Feature',
        'geometry': {
            'type': 'LineString',
            'coordinates': [[uLng, uLat], [pLng, pLat]]
        }
    };

    if (map.getSource('connecting-line')) {
        map.getSource('connecting-line').setData(lineGeoJSON);
    } else {
        map.addSource('connecting-line', {
            'type': 'geojson',
            'data': lineGeoJSON
        });

        map.addLayer({
            'id': 'connecting-line-layer',
            'type': 'line',
            'source': 'connecting-line',
            'layout': {
                'line-join': 'round',
                'line-cap': 'round'
            },
            'paint': {
                'line-color': '#fa6800',
                'line-width': 3,
                'line-dasharray': [2, 1]
            }
        });
    }

    if (lineDistanceMarker) lineDistanceMarker.remove();

    const el = document.createElement('div');
    el.className = 'line-distance-badge';
    el.innerText = park.distanceDisplay;

    lineDistanceMarker = new maplibregl.Marker({ element: el, offset: [0, -26] })
        .setLngLat([pLng, pLat])
        .addTo(map);
}

function selectCarpark(parkId) {
    selectedParkId = parkId;
    const park = parkingStations.find(p => p.id === parkId);
    if (!park) return;

    if (map) {
        map.flyTo({
            center: [park.longitude, park.latitude],
            zoom: 16,
            speed: 1.2,
            curve: 1.4
        });
    }

    updateConnectingLine(park);

    mapMarkersMap.forEach((marker, id) => {
        const el = marker.getElement();
        if (id === parkId) {
            el.classList.add('active');
        } else {
            el.classList.remove('active');
        }
    });

    const listContainer = document.getElementById('nearby-list');
    const listItems = document.querySelectorAll('.nearby-item');
    let targetItem = null;

    listItems.forEach(item => {
        if (item.dataset.id === parkId) {
            item.classList.add('active');
            targetItem = item;
        } else {
            item.classList.remove('active');
        }
    });

    if (targetItem && listContainer) {
        const containerRect = listContainer.getBoundingClientRect();
        const itemRect = targetItem.getBoundingClientRect();

        const itemCenter = itemRect.top + itemRect.height / 2;
        const containerCenter = containerRect.top + containerRect.height / 2;
        const scrollDiff = itemCenter - containerCenter;

        listContainer.scrollBy({
            top: scrollDiff,
            behavior: 'smooth'
        });
    }
}

function renderNearbyPage() {
    const listEl = document.getElementById('nearby-list');
    listEl.innerHTML = '';

    mapMarkersMap.forEach(m => m.remove());
    mapMarkersMap.clear();

    if (lineDistanceMarker) {
        lineDistanceMarker.remove();
        lineDistanceMarker = null;
    }

    const filtered = parkingStations.filter(p => p.rawDistance <= currentRadius);

    if (filtered.length === 0) {
        listEl.innerHTML = '<div class="loading-text">搜尋半徑內沒有找到停車場</div>';
        return;
    }

    filtered.forEach(park => {
        const vacancyInfo = formatVacancy(park.vacancyType, park.vacancy);
        
        if (map) {
            const container = document.createElement('div');
            container.className = `park-marker-container ${selectedParkId === park.id ? 'active' : ''}`;
            container.dataset.id = park.id;
            container.innerHTML = `
                <div class="park-marker-dot"></div>
                <div class="park-marker-badge">${vacancyInfo.text}</div>
            `;

            container.addEventListener('click', (e) => {
                e.stopPropagation();
                selectCarpark(park.id);
            });

            const marker = new maplibregl.Marker({ element: container, anchor: 'left' })
                .setLngLat([park.longitude, park.latitude])
                .addTo(map);

            mapMarkersMap.set(park.id, marker);
        }

        const itemEl = document.createElement('div');
        itemEl.className = `nearby-item ${selectedParkId === park.id ? 'active' : ''}`;
        itemEl.dataset.id = park.id;
        itemEl.innerHTML = `
            <div class="nearby-dist">${park.distanceDisplay}</div>
            <div class="nearby-info">
                <div class="nearby-name">${park.name}</div>
                <div class="nearby-addr">${park.address}</div>
            </div>
            <div class="nearby-val" style="${vacancyInfo.cssClass === 'full' ? 'color:#ce352c;' : ''}">
                ${vacancyInfo.text}
            </div>
        `;

        itemEl.addEventListener('click', () => {
            selectCarpark(park.id);
        });

        listEl.appendChild(itemEl);
    });

    if (selectedParkId) {
        const selectedPark = filtered.find(p => p.id === selectedParkId);
        if (selectedPark) updateConnectingLine(selectedPark);
    }
}

function updateStatusText(text) {
    document.querySelectorAll('.location-status').forEach(el => el.innerText = text);
}

function updateDashboard() {
    const dashName = document.getElementById('dash-nearest-name');
    const dashDist = document.getElementById('dash-nearest-dist');
    const dashVal = document.getElementById('dash-nearest-val');
    const dashExpandList = document.getElementById('dash-expanded-list');

    if (parkingStations.length > 0) {
        const nearest = parkingStations[0];
        const vacancyInfo = formatVacancy(nearest.vacancyType, nearest.vacancy);
        
        dashName.innerText = nearest.name;
        dashDist.innerText = nearest.distanceDisplay;
        dashVal.innerText = vacancyInfo.text;
        
        dashExpandList.innerHTML = '';
        const nextThree = parkingStations.slice(1, 4);
        nextThree.forEach(p => {
            const vInfo = formatVacancy(p.vacancyType, p.vacancy);
            dashExpandList.innerHTML += `
                <div class="compact-item">
                    <div class="compact-info">
                        <span class="compact-name">${p.name}</span>
                        <span class="compact-dist">${p.distanceDisplay}</span>
                    </div>
                    <span class="compact-val">${vInfo.text}</span>
                </div>
            `;
        });
    }
}

function renderParkingStations() {
    const listEl = document.getElementById('parking-list');
    listEl.innerHTML = '';
    
    parkingStations.slice(0, 30).forEach(park => {
        const vacancyInfo = formatVacancy(park.vacancyType, park.vacancy);
        listEl.innerHTML += `
            <div class="park-item status-${vacancyInfo.cssClass}">
                <div class="park-info">
                    <div class="park-title">${park.name}</div>
                    <div class="park-address">${park.address}</div>
                    <div class="park-distance">${park.distanceDisplay || '--'}</div>
                </div>
                <div class="park-numbers">
                    <div class="park-available">${vacancyInfo.text}</div>
                    <div class="park-total">車位</div>
                </div>
            </div>
        `;
    });
}

function renderEvStations() {
    const evListEl = document.getElementById('ev-list');
    evListEl.innerHTML = '';
    evStations.forEach(station => {
        evListEl.innerHTML += `
            <div class="ev-item">
                <div class="ev-header">
                    <div class="ev-title">${station.name}</div>
                    <div class="ev-address">${station.address}</div>
                    <div class="ev-distance">${station.distanceDisplay || '--'}</div>
                </div>
                <div class="ev-chargers">
                    <div class="charger-type">
                        <span class="charger-label">快速充電 (DC)</span>
                        <div class="charger-data available-high"><span>${station.fast.available}</span> / ${station.fast.total}</div>
                    </div>
                    <div class="charger-type">
                        <span class="charger-label">中速充電 (AC)</span>
                        <div class="charger-data available-high"><span>${station.medium.available}</span> / ${station.medium.total}</div>
                    </div>
                </div>
            </div>
        `;
    });
}
