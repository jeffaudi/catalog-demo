// 
//  Copyright (C) 2015, Jeff Faudi <jeffaudi@gmail.com>, Airbus Defense and Space
//  
//  Permission to use, copy, modify, and/or distribute this software for any purpose 
//  with or without fee is hereby granted, provided that the above copyright notice 
//  and this permission notice appear in all copies.
//  
//  THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH REGARD TO THIS SOFTWARE
//  INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE
//  FOR ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM 
//  LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, 
//  ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
// 
//  http://www.isc.org/downloads/software-support-policy/isc-license/
// 


// insert here your API key for Google Geocoder
var GOOGLE_API_KEY = 'AIzaSyCqrm8Tj8JMhvv835awuG9QajTB2De1RuU';

// the map and the sidebar
var map = null;
var sidebar = null;

// the list of images from the current request
var current = {};

// the list of images from the previous request (in case of panning)
var previous = {};
var metadata = {};

// the requests are borken down in small chunks to avoid blocking th browser.
// this is the max number of results per individual requests
var max_results = 100;

// this is the max number of requests i.e. 5,000 images displayed on the screen
var max_pages = 50;
var page = 0;

// this is the list of polygon i.e. images displayed on the screen
var polygons = [];

// the is the handle to the AJAX query made to the API
var deferred = null;
var timeout = null;

// these are the display options for the images depending on the size of the screen
var polyOptions1 = {stroke: true, color: '#50f', weight: 3, fill: true, fillOpacity: 0.2, clickable: true};
var polyOptions2 = {stroke: true, color: '#03f', weight: 3, fill: true, fillOpacity: 0.2, clickable: true};
var lineOptions1 = {stroke: true, color: '#50f', weight: 3};
var lineOptions2 = {stroke: true, color: '#03f', weight: 3};

function initialize() {

    // remove the preloader
    $(".se-pre-con").fadeOut("slow");

    // this is to go around a bug of unwanted scrolling when you click on the map
    L.Map.addInitHook(function () {
        return L.DomEvent.off(this._container, "mousedown", this.keyboard._onMouseDown);
    });

    // create up the map
    map = L.map('map');

    // define the initial view (adapt to your case)
    map.setView([20.0, 0.0], 4);

    // create the tile layer with correct attribution
    var osmUrl='http://{s}.tile.osm.org/{z}/{x}/{y}.png';
    var osm = new L.TileLayer(osmUrl, {
        attribution: '&copy; <a href="http://osm.org/copyright">OpenStreetMap</a> contributors'
    });

    // add OSM as background
    map.addLayer(osm);

    // add a sidebar to the map 
    sidebar = L.control.sidebar('sidebar', {
        position: 'left'
    });
    map.addControl(sidebar);


    // define behavior when basemap is shifted (panning)
    map.on('moveend', function(e) {
        query_catalog_shift();
    });

    // attach controler to parameters fields
    $( "#image_type" ).on('change', query_catalog_restart);
    $( "#cloud_cover" ).on('change', query_catalog_restart);
    $( "#incidence_angle" ).on('change', query_catalog_restart);
    $( "#date_interval" ).on('change', query_catalog_restart);

    // define the function to download the metadata of the displayed images
    $("#download_ids").on("click", function(e) {
        var csv = "imageId\torbitNumber\tplatform\tacquisitionDate\tinstrument\tcloudCover\tsnowCover\tincidenceAngle\tilluminationAzimuthAngle\tilluminationElevationAngle\torientationAngle\tquicklookUrl\n";   
         // ajouter un entete
        for (var id in metadata) {
            var record = metadata[id]['properties'];
            csv += record['id'] + "\t" + record['orbitNumber'] + "\t" + record['platform'] + "\t" + record['acquisitionDate'] + "\t" + record['instrument'] + "\t" + record['cloudCover'] + "\t" + record['snowCover'] + "\t" + record['incidenceAngle'] + "\t" + record['illuminationAzimuthAngle'] + "\t" + record['illuminationElevationAngle'] + "\t" + record['orientationAngle'] + "\t" + record['quicklookUrl'] + "\n";   
        }
        // return csv
        $("#download_ids").attr("download", "airbusds-geo-selected-ids.csv");
        $("#download_ids").attr("href", 'data:application/octet-stream,' + encodeURIComponent(csv));
    });

    // if browser geolocation is available, move the map to current location
    if (navigator.geolocation) {
        navigator.geolocation.getCurrentPosition(function(pos) {
            var crd = pos.coords;
            query_catalog_abort();
            map.setView([crd.latitude, crd.longitude], 7);
        });
    }

    // attach controler to location field 
    $( "#location" ).change(function() {
        // call Google Geocoder API
        var url = "https://maps.googleapis.com/maps/api/geocode/json?address=" + $( "#location" ).val() + "&key=" + GOOGLE_API_KEY;
        $.ajax({
            dataType: "json",
            url: url,
            success: function( response ) {
                // use the first result
                var first = response['results'][0];
                $( "#location" ).val(first['formatted_address']);
                var viewport = first['geometry']['viewport'];
                var southWest = L.latLng(viewport["southwest"]["lat"], viewport["southwest"]["lng"]);
                var northEast = L.latLng(viewport["northeast"]["lat"], viewport["northeast"]["lng"]);
                // get bounds of results and set map to the bounds
                var bounds = L.latLngBounds(southWest, northEast);
                map.fitBounds(bounds);
            }
        });
    });

    // query catalog the first time if mode is bounds
    query_catalog_restart();
}

function query_catalog_abort() {
    if (setTimeout)
        window.clearTimeout(timeout);
    if (deferred)
        $.when( deferred ).done(function () {
            if (setTimeout)
                window.clearTimeout(timeout);
            deferred = null;
            query_catalog_reset();
        });
    else
        query_catalog_reset();
}

function query_catalog_reset() {
    for (var ident in current) {
        map.removeLayer(current[ident]);
        delete current[ident]
    }
    
    for (var ident in previous) {
        map.removeLayer(previous[ident]);
        delete previous[ident];
    }
    
    for (var ident in metadata) {
        delete metadata[ident]
    }
}

function query_catalog_shift() {
    for (var ident in current) {
        previous[ident] = current[ident];
        delete current[ident]
    }
    query_catalog_start();
}

function query_catalog_restart() {
    if ($(window).width() < 576) {
        $( "#accordion" ).collapsible( "collapse" );
    }

    query_catalog_abort();
    query_catalog_start();
}

function query_catalog_start() {
    for (var ident in metadata) {
        delete metadata[ident]
    }
    page = 0;
    if (deferred)
        $.when( deferred ).done(function () {
            deferred = null;
            query_catalog_restart();
        });
    else
        query_catalog_bypage();
}

function query_catalog_bypage() {

    // define paging
    var start = page * max_results;
    params = 'startIndex=' + start + '&itemsPerPage=' + max_results;

    // compute start and end date based on current date and selected interval
    var dt = new Date();
    var date_end = dt.toISOString().substr(0, 10);
    var time = dt.getTime();

    var interval = $( "#date_interval" ).val();
    if (interval == "2w")
        time = time - 2 * 7 * 24 * 3600 * 1000;
    else if (interval == "1m")
        time = time - 30 * 24 * 3600 * 1000;
    else if (interval == "2m")
        time = time - 2 * 30 * 24 * 3600 * 1000;
    else if (interval == "3m")
        time = time - 3 * 30 * 24 * 3600 * 1000;
    else if (interval == "6m")
        time = time - 6 * 30 * 24 * 3600 * 1000;
    else if (interval == "1y")
        time = time - 365 * 24 * 3600 * 1000;
    else if (interval == "2y")
        time = time - 2 * 365 * 24 * 3600 * 1000;
    else
        time = time - 5 * 365 * 24 * 3600 * 1000;
 
    dt.setTime(time);
    var date_start = dt.toISOString().substr(0, 10);

    // add filters for acquisition date
    params += '&acquisitionDate=[' + date_start + ',' + date_end + ']';

    // add filter for cloud cover
    max_cc = $( "#cloud_cover" ).val();
    params += '&cloudCover=' + max_cc + ']';
    //params += '&snowCover=10]';

    // add filter for incidence angle
    max_ia = $( "#incidence_angle" ).val();
    params += '&incidenceAngle=' + max_ia + ']';

    // add filter for type of satellite
    var type = $( "#image_type" ).val();
    if (type == "p") {
        params += '&satellite=PLEIADES';
    }
    else if (type == "s") {
        params += '&satellite=SPOT';
    }

    // get bounds from the current display
    var bounds = map.getBounds();

    // make sure the bounds are within accepted values
    var bottom_left_lng = Math.max(bounds.getWest(), -179.99);
    var bottom_left_lat = Math.max(bounds.getSouth(), -89.99);
    var top_right_lng = Math.min(bounds.getEast(), 179.99);
    var top_right_lat = Math.min(bounds.getNorth(), 89.99);

    // create the bbox parameter
    params += '&bbox=' + bottom_left_lng + ',' + bottom_left_lat + ',' + top_right_lng + ',' + top_right_lat;

    // this is the URL to the (beta) Catalog API V2
    var url = 'http://api2.astrium-geo.com/search/?' + params;

    // send an AJAX request to the API
    deferred = $.ajax({
        url: url,
        type: "GET",
        dataType: "json",
        //contentType: 'application/x-www-form-urlencoded; charset=UTF-8',
        processData: false,
        //data: params,
        success: function (response) {
            // check first for any error
            if (response['error'] === false) {
                // get the total number of images matching the criterias
                total = response['found'];
                // get the number of images returned by this response
                hits = response['features'].length;
                if (hits > 0) {
                    // parse each image in the result
                    for (var i=0; i < hits; i++) {
                        feature = response['features'][i];
                        temp = {};
                        temp.ident = feature['properties']['id']; 
                        temp.date = feature['properties']['acquisitionDate'].substr(0, 10);  
                        temp.angle = feature['properties']['incidenceAngle'];
                        temp.satel = feature['properties']['platform'];
                        geom = feature['geometry']['coordinates'][0];
                        // GeoJSON and Leaflet swap latitude and longitude  
                        jQuery.map(geom, function(item) {
                            t = item[0];
                            item[0] = item[1];
                            item[1] = t;
                        });
                        temp.geom = geom;
                        // store metadata in case CSV export is requested
                        metadata[temp.ident] = feature;
                        if (temp.ident in previous) {
                            // if the image is already display on map, just mark it as current
                            current[temp.ident] = previous[temp.ident];
                            delete previous[temp.ident]
                        }
                        else {
                            // draw the image on map 
                            if (temp.ident) {
                                var poly;
                                // display style depends on type of image and size of device screen
                                if ($(window).width() > 768)
                                    if (temp.satel.indexOf("PHR") === 0)
                                        poly = L.polyline(temp.geom, lineOptions1); 
                                    else
                                        poly = L.polyline(temp.geom, lineOptions2); 
                                else {
                                    if (temp.satel.indexOf("PHR") === 0)
                                        poly = L.polygon(temp.geom, polyOptions1); 
                                    else
                                        poly = L.polygon(temp.geom, polyOptions2); 
                                 }

                                // store important information in poly
                                poly.metadata = feature;
                                poly.preview = L.imageOverlay('http://ql2.astrium-geo.com/map/' + temp.ident, poly.getBounds());

                                // Prepare show sidebar callback
                                poly.on('click', function (e) {

                                    // toggle quick look on the map
                                    if (map.hasLayer(e.target.preview)) {
                                        map.removeLayer(e.target.preview);                                    
                                    }
                                    else {
                                        var content = '<a id="order" target="_blank" href="satellite-image/?id=' + e.target.metadata.properties.id + '" data-role="button" data-theme="a">Order this image!</a>';
                                        content += '<div class="ui-grid-a ui-responsive">';
                                        content += '<div class="ui-block-a"><div class="ui-bar ui-bar-a">Identifier</div></div><div class="ui-block-b"><div class="ui-body ui-body-a" id="image-name">' + e.target.metadata.properties.id + '</div></div>';
                                        content += '<div class="ui-block-a"><div class="ui-bar ui-bar-a">Date</div></div><div class="ui-block-b"><div class="ui-body ui-body-a" id="image-date">' + e.target.metadata.properties.acquisitionDate.substr(0, 10) + '</div></div>';
                                        content += '<div class="ui-block-a"><div class="ui-bar ui-bar-a">Incidence angle</div></div><div class="ui-block-b"><div class="ui-body ui-body-a" id="image-angle">' + Math.round(e.target.metadata.properties.incidenceAngle) + '°</div></div>';
                                        content += '<div class="ql_image"><img src="http://ql2.astrium-geo.com/raw/' + e.target.metadata.properties.id + '"></div>';
                                        content += '<div class="ui-block-a"><div class="ui-bar ui-bar-a">Cloud Coverage</div></div><div class="ui-block-b"><div class="ui-body ui-body-a" id="image-cloud">' + Math.round(e.target.metadata.properties.cloudCover) + '%</div></div>';
                                        content += '<div class="ui-block-a"><div class="ui-bar ui-bar-a">Snow coverage</div></div><div class="ui-block-b"><div class="ui-body ui-body-a" id="image-snow">' + Math.round(e.target.metadata.properties.snowCover) + '%</div></div>';
                                        content += '<div class="ui-block-a"><div class="ui-bar ui-bar-a">Resolution</div></div><div class="ui-block-b"><div class="ui-body ui-body-a" id="image-resolution">' + e.target.metadata.properties.resolution + ' m.</div></div>';
                                        content += '<div class="ui-block-a"><div class="ui-bar ui-bar-a">Sun azimuth</div></div><div class="ui-block-b"><div class="ui-body ui-body-a" id="image-azimuth">' + Math.round(e.target.metadata.properties.illuminationAzimuthAngle) + '°</div></div>';
                                        content += '<div class="ui-block-a"><div class="ui-bar ui-bar-a">Sun elevation</div></div><div class="ui-block-b"><div class="ui-body ui-body-a" id="image-elevation">' + Math.round(e.target.metadata.properties.illuminationElevationAngle) + '°</div></div>';
                                        content += '<div class="ui-block-a"><div class="ui-bar ui-bar-a">Orientation</div></div><div class="ui-block-b"><div class="ui-body ui-body-a" id="image-orientation">' + Math.round(e.target.metadata.properties.orientationAngle) + '°</div></div>';
                                        content += '</div>';
                                        sidebar.setContent(content);
                                        $( "#order" ).button();
                                        sidebar.show();

                                        // display preview on big screens
                                        if ($(window).width() > 768)
                                            map.addLayer(e.target.preview);
                                    }
                                });
                            }
                            //poly.setStyle( <Path options> object )
                            map.addLayer(poly, true);
                            current[temp.ident] = poly;
                        }
                    }
                }
            }
            else {
                // no images found
                for (var ident in previous) {
                    map.removeLayer(previous[ident]);
                    delete previous[ident];
                }
            }

            // adapt title of window based on available space
            if ($(window).width() > 800) {
                $( "#title" ).html("Showing " + (page * max_results + hits) + " out of " + total + " " + $( "#image_type option:selected" ).text() + " images acquired over the last " + $( "#date_interval option:selected" ).text());
            }
            else  {
                $( "#title" ).html("Showing " + (page * max_results + hits) + " out of " + total + " images acquired over the last " + $( "#date_interval option:selected" ).text());
            }

            // if more images are available, define a new request to the API
            if (((page * max_results + hits) < total) && (page < max_pages - 1)) {
                page = page + 1;
                timeout = window.setTimeout(query_catalog_bypage, 500);
            }
            else {
                timeout = null;
                for (var ident in previous) {
                    map.removeLayer(previous[ident]);
                    delete previous[ident];
                }
            }
            deferred = null;
        },
        failure: function () {
            // Network error!
            $( "#message" ).html("There has been an error.<br>This application needs Internet connectivity.");
            deferred = null;
        }
    });
}

