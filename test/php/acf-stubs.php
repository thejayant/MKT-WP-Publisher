<?php
/**
 * Stand-ins for the Advanced Custom Fields functions the bridge uses, loaded only by scenarios that need ACF.
 * Values are stored the way ACF loads them: repeater, group and layout rows keyed by sub field KEY.
 * $GLOBALS['acf']['groups'] is a list of {match: callable(screen): bool, fields: [field, …]}.
 */

define( 'ACF_VERSION', '6.3.5' );

$GLOBALS['acf'] = array(
	'groups'  => array(),
	'values'  => array(),
	'writes'  => array(),
	'screens' => array(),
	'throws'  => false,
);

function acf_get_field_groups( $screen = array() ) {
	$GLOBALS['acf']['screens'][] = $screen;
	$out                         = array();
	foreach ( $GLOBALS['acf']['groups'] as $group ) {
		if ( call_user_func( $group['match'], $screen ) ) {
			$out[] = $group;
		}
	}
	return $out;
}

function acf_get_fields( $group ) {
	return $group['fields'];
}

function acf_get_value( $post_id, $field ) {
	if ( $GLOBALS['acf']['throws'] ) {
		throw new RuntimeException( 'database gone' );
	}
	return $GLOBALS['acf']['values'][ $post_id ][ $field['key'] ] ?? null;
}

function update_field( $selector, $value, $post_id = false ) {
	if ( $GLOBALS['acf']['throws'] ) {
		throw new RuntimeException( 'database gone' );
	}
	$GLOBALS['acf']['writes'][]                       = array( $selector, $value, $post_id );
	$GLOBALS['acf']['values'][ $post_id ][ $selector ] = $value;
	return true;
}
