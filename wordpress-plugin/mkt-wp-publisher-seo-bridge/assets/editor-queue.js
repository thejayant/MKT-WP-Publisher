/**
 * MKT Publisher SEO Bridge: changes waiting in the block editor.
 *
 * WP Publisher (for Claude) can leave a proposed new version of a post's content in the editor queue. While the post is
 * open in the block editor, this script shows each waiting change as a notice with Apply and Dismiss buttons.
 * Apply replaces the blocks in the editor only: nothing is saved until the person clicks Save or Update, and Undo
 * brings the previous blocks back. A change is applied only to the exact version it was prepared from, and never over
 * unsaved edits.
 */
( function ( wp, config ) {
	'use strict';

	if ( ! wp || ! wp.data || ! wp.apiFetch || ! wp.blocks || ! config || ! config.route ) {
		return;
	}

	var data = wp.data;
	var shown = {}; // item id -> true while its notice is on screen
	var applied = {}; // item ids applied here whose status could not be saved yet
	var postId = 0;
	var timer = null;
	var busy = false;

	function editor() {
		return data.select( 'core/editor' );
	}

	function notices() {
		return data.dispatch( 'core/notices' );
	}

	function stamp( text ) {
		return String( text || '' ).replace( /(?:\.\d+)?(?:Z|\+00:00)$/i, '' );
	}

	function noticeId( item ) {
		return 'mkt-editor-queue-' + item.id;
	}

	function say( type, message, id ) {
		notices().createNotice( type, message, { id: id || 'mkt-editor-queue-message', isDismissible: true } );
	}

	function setStatus( item, status ) {
		return wp.apiFetch( {
			path: config.route + postId + '/' + item.id,
			method: 'POST',
			data: { status: status },
		} );
	}

	function forget( item ) {
		notices().removeNotice( noticeId( item ) );
		delete shown[ item.id ];
	}

	function apply( item ) {
		var current = editor();
		if ( current.isEditedPostDirty() ) {
			say( 'warning', 'Save or undo your own unsaved changes first, then click Apply again.' );
			return;
		}
		var post = current.getCurrentPost() || {};
		if ( stamp( post.modified_gmt ) !== stamp( item.base_modified_gmt ) ) {
			say( 'error', 'This change was prepared for an earlier version of this page. Dismiss it and ask Claude to prepare it again.' );
			return;
		}
		var blocks;
		try {
			blocks = wp.blocks.parse( item.content );
		} catch ( error ) {
			say( 'error', 'This change could not be read by the editor. Dismiss it and ask Claude to prepare it again.' );
			return;
		}
		var actions = data.dispatch( 'core/editor' );
		if ( typeof actions.resetEditorBlocks === 'function' ) {
			actions.resetEditorBlocks( blocks );
		} else {
			actions.editPost( { content: item.content } );
			data.dispatch( 'core/block-editor' ).resetBlocks( blocks );
		}
		applied[ item.id ] = true;
		forget( item );
		notices().createNotice( 'success', 'Change applied in the editor. Review it, then click Save or Update to keep it (or Undo to remove it).', {
			id: 'mkt-editor-queue-applied',
			type: 'snackbar',
		} );
		setStatus( item, 'applied' ).then( function () {
			delete applied[ item.id ];
		}, function () {} ); // Retried on the next check.
	}

	function dismiss( item ) {
		setStatus( item, 'dismissed' ).then( function () {
			forget( item );
		}, function () {
			say( 'error', 'The change could not be dismissed. Check your connection and try again.' );
		} );
	}

	function show( item ) {
		var count = Array.isArray( item.summary ) ? item.summary.length : 0;
		var label = item.label ? '"' + item.label + '"' : 'a change';
		notices().createNotice(
			'info',
			'Claude prepared ' + label + ( count ? ' (' + count + ( count === 1 ? ' edit' : ' edits' ) + ')' : '' ) + ' for this page. Apply it to review it here; nothing is saved until you click Save or Update.',
			{
				id: noticeId( item ),
				isDismissible: false,
				actions: [
					{ label: 'Apply', onClick: function () { apply( item ); } },
					{ label: 'Dismiss', onClick: function () { dismiss( item ); } },
				],
			}
		);
		shown[ item.id ] = true;
	}

	function check() {
		if ( busy || ! postId || document.hidden ) {
			return;
		}
		busy = true;
		wp.apiFetch( { path: config.route + postId + '?content=1' } ).then( function ( response ) {
			busy = false;
			var items = response && Array.isArray( response.items ) ? response.items : [];
			var pending = {};
			items.forEach( function ( item ) {
				if ( item.status !== 'pending' ) {
					return;
				}
				if ( applied[ item.id ] ) {
					setStatus( item, 'applied' ).then( function () {
						delete applied[ item.id ];
					}, function () {} );
					return;
				}
				pending[ item.id ] = true;
				if ( ! shown[ item.id ] ) {
					show( item );
				}
			} );
			// Applied or dismissed elsewhere (another tab, or by Claude).
			Object.keys( shown ).forEach( function ( id ) {
				if ( ! pending[ id ] ) {
					forget( { id: id } );
				}
			} );
		}, function () {
			busy = false; // Offline, logged out or the bridge was removed: try again later, quietly.
		} );
	}

	function start() {
		check();
		timer = window.setInterval( check, Math.max( 5000, Number( config.interval ) || 15000 ) );
		document.addEventListener( 'visibilitychange', function () {
			if ( ! document.hidden ) {
				check();
			}
		} );
	}

	// The post ID is known once the editor has loaded the post.
	var unsubscribe = null;
	function tryStart() {
		var current = editor();
		var id = current && typeof current.getCurrentPostId === 'function' ? current.getCurrentPostId() : 0;
		if ( typeof id !== 'number' || id < 1 || timer ) {
			return;
		}
		postId = id;
		if ( unsubscribe ) {
			unsubscribe();
		}
		start();
	}
	unsubscribe = data.subscribe( tryStart );
	tryStart();
} )( window.wp, window.mktEditorQueue );
