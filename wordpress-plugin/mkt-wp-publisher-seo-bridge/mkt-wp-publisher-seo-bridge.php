<?php
/**
 * Plugin Name: MKT WP Publisher SEO Bridge
 * Description: Lets the MKT WP Publisher Claude extension read and write the SEO title, meta description and focus keyword of Yoast SEO or Rank Math through the WordPress REST API.
 * Version: 1.0.0
 * Author: Jayant
 * Requires at least: 5.6
 * Requires PHP: 7.4
 * License: GPL-2.0-or-later
 *
 * Adds one REST field, "mkt_seo", to posts and pages (edit context only):
 *   { "plugin": "yoast" | "rank-math" | "none", "title": "", "description": "", "focus_keyword": "" }
 * Writing it requires permission to edit that post. An empty string removes the value.
 *
 * Neither SEO plugin registers its post meta for the REST API, which is why this bridge exists.
 * The values are written right after WordPress saves the post. Yoast refreshes its cached
 * "indexable" on the next save, and publishing (including scheduled publishing) is such a save,
 * so the published page always uses the values written here.
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * Meta keys for the active SEO plugin, or null when neither is active. Yoast wins if both are.
 */
function mkt_seo_bridge_keys() {
	if ( defined( 'WPSEO_VERSION' ) ) {
		return array(
			'plugin'        => 'yoast',
			'title'         => '_yoast_wpseo_title',
			'description'   => '_yoast_wpseo_metadesc',
			'focus_keyword' => '_yoast_wpseo_focuskw',
		);
	}
	if ( defined( 'RANK_MATH_VERSION' ) || class_exists( 'RankMath' ) ) {
		return array(
			'plugin'        => 'rank-math',
			'title'         => 'rank_math_title',
			'description'   => 'rank_math_description',
			'focus_keyword' => 'rank_math_focus_keyword',
		);
	}
	return null;
}

add_action(
	'rest_api_init',
	function () {
		$keys   = mkt_seo_bridge_keys();
		$fields = array( 'title', 'description', 'focus_keyword' );

		foreach ( array( 'post', 'page' ) as $post_type ) {
			register_rest_field(
				$post_type,
				'mkt_seo',
				array(
					'get_callback'    => function ( $object ) use ( $keys, $fields ) {
						if ( ! current_user_can( 'edit_post', $object['id'] ) ) {
							return null;
						}
						$value = array( 'plugin' => $keys ? $keys['plugin'] : 'none' );
						foreach ( $fields as $field ) {
							$value[ $field ] = $keys ? (string) get_post_meta( $object['id'], $keys[ $field ], true ) : '';
						}
						return $value;
					},
					'update_callback' => function ( $value, $post ) use ( $keys, $fields ) {
						if ( ! is_array( $value ) || ! $keys ) {
							return true; // Nothing to write; the extension checks "plugin" before sending.
						}
						if ( ! current_user_can( 'edit_post', $post->ID ) ) {
							return new WP_Error( 'rest_cannot_edit', 'Sorry, you are not allowed to edit the SEO fields of this post.', array( 'status' => rest_authorization_required_code() ) );
						}
						foreach ( $fields as $field ) {
							if ( ! array_key_exists( $field, $value ) ) {
								continue;
							}
							$text = sanitize_text_field( (string) $value[ $field ] );
							if ( '' === $text ) {
								delete_post_meta( $post->ID, $keys[ $field ] );
							} else {
								update_post_meta( $post->ID, $keys[ $field ], wp_slash( $text ) );
							}
						}
						return true;
					},
					'schema'          => array(
						'description'          => 'SEO title, meta description and focus keyword (MKT WP Publisher SEO Bridge).',
						'type'                 => 'object',
						'context'              => array( 'edit' ),
						'additionalProperties' => false,
						'properties'           => array(
							// The enum tells the extension, via an OPTIONS request, which SEO plugin is active.
							'plugin'        => array(
								'type'     => 'string',
								'enum'     => array( $keys ? $keys['plugin'] : 'none' ),
								'readonly' => true,
							),
							'title'         => array( 'type' => 'string' ),
							'description'   => array( 'type' => 'string' ),
							'focus_keyword' => array( 'type' => 'string' ),
						),
					),
				)
			);
		}
	}
);
